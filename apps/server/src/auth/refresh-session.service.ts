import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';

import { ApiException } from '../common/api-exception';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { lockUserForUpdate } from '../database/user-lock';
import { AuthConfigService } from '../config/auth.config';
import type { PublicUser } from './auth.types';
import { CookieService } from './cookie.service';
import { TokenService } from './token.service';

export interface RefreshSessionResult {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  user: PublicUser;
}

function clientSummary(input: { ip?: string; userAgent?: string }): string {
  const ip = (input.ip || 'unknown').replace(/[^A-Za-z0-9:._-]/g, '').slice(0, 64) || 'unknown';
  const userAgent = [...(input.userAgent || 'unknown')]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .slice(0, 160);
  return `${ip} ${userAgent || 'unknown'}`.slice(0, 255);
}

@Injectable()
export class RefreshSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authConfig: AuthConfigService,
    private readonly cookies: CookieService,
    private readonly tokenService: TokenService,
    private readonly audit: AuditService,
  ) {}

  hashToken(token: string): string {
    return createHmac('sha256', this.authConfig.values.refreshTokenHashSecret)
      .update(token)
      .digest('hex');
  }

  async create(
    user: PublicUser,
    context: { ip?: string; userAgent?: string },
    expectedTokenVersion: number,
  ): Promise<RefreshSessionResult> {
    const result = await this.prisma.$transaction(async (transaction) => {
      if (!(await lockUserForUpdate(transaction, user.id))) {
        throw new ApiException('AUTH_TOKEN_EXPIRED');
      }
      const current = await transaction.user.findUnique({ where: { id: user.id } });
      if (!current) throw new ApiException('AUTH_TOKEN_EXPIRED');
      if (current.status === UserStatus.DISABLED) {
        throw new ApiException('AUTH_ACCOUNT_DISABLED');
      }
      if (current.tokenVersion !== expectedTokenVersion) {
        throw new ApiException('AUTH_TOKEN_EXPIRED');
      }

      const refreshToken = this.cookies.createRefreshToken();
      const csrfToken = this.cookies.createCsrfToken();
      const expiresAt = new Date(Date.now() + this.authConfig.values.refreshTokenTtlSeconds * 1000);
      await transaction.refreshToken.create({
        data: {
          userId: current.id,
          tokenHash: this.hashToken(refreshToken),
          expiresAt,
          clientSummary: clientSummary(context),
        },
      });
      return {
        accessToken: this.tokenService.issueAccessToken({
          userId: current.id,
          role: current.role,
          tokenVersion: current.tokenVersion,
        }),
        refreshToken,
        csrfToken,
        user: this.toPublicUser(current),
      };
    });
    return result;
  }

  async rotate(
    refreshToken: string | undefined,
    context: { ip?: string; userAgent?: string; requestId?: string },
  ): Promise<RefreshSessionResult> {
    if (!refreshToken) throw new ApiException('AUTH_TOKEN_EXPIRED');
    const tokenHash = this.hashToken(refreshToken);
    const now = new Date();
    const newRefreshToken = this.cookies.createRefreshToken();
    const csrfToken = this.cookies.createCsrfToken();
    const expiresAt = new Date(Date.now() + this.authConfig.values.refreshTokenTtlSeconds * 1000);

    try {
      const result = await this.prisma.$transaction(
        async (transaction) => {
          const tokenReference = await transaction.refreshToken.findUnique({
            where: { tokenHash },
            select: { userId: true },
          });
          if (!tokenReference) throw new ApiException('AUTH_TOKEN_EXPIRED');
          if (!(await lockUserForUpdate(transaction, tokenReference.userId))) {
            throw new ApiException('AUTH_TOKEN_EXPIRED');
          }
          const current = await transaction.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: true },
          });
          if (!current || current.revokedAt || current.expiresAt <= now)
            throw new ApiException('AUTH_TOKEN_EXPIRED');
          if (current.user.status === UserStatus.DISABLED)
            throw new ApiException('AUTH_ACCOUNT_DISABLED');
          const claimed = await transaction.refreshToken.updateMany({
            where: { id: current.id, tokenHash, revokedAt: null, expiresAt: { gt: now } },
            data: { revokedAt: now, lastUsedAt: now },
          });
          if (claimed.count !== 1) throw new ApiException('AUTH_TOKEN_EXPIRED');
          const next = await transaction.refreshToken.create({
            data: {
              userId: current.userId,
              tokenHash: this.hashToken(newRefreshToken),
              expiresAt,
              clientSummary: clientSummary(context),
            },
          });
          await this.audit.record(
            {
              actorId: current.userId,
              action: 'AUTH_REFRESH_ROTATED',
              resourceType: 'RefreshToken',
              resourceId: next.id,
              requestId: context.requestId,
              metadata: { outcome: 'rotated' },
            },
            transaction,
          );
          return { user: this.toPublicUser(current.user), tokenVersion: current.user.tokenVersion };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
      return {
        accessToken: this.tokenService.issueAccessToken({
          userId: result.user.id,
          role: result.user.role,
          tokenVersion: result.tokenVersion,
        }),
        refreshToken: newRefreshToken,
        csrfToken,
        user: result.user,
      };
    } catch (error) {
      if (error instanceof ApiException) {
        await this.recordRejectedRefresh(context, error.code);
        throw error;
      }
      await this.recordRejectedRefresh(context, 'internal');
      throw new ApiException('AUTH_TOKEN_EXPIRED');
    }
  }

  async revoke(
    refreshToken: string | undefined,
    context: { requestId?: string; actorId?: string },
  ): Promise<void> {
    if (!refreshToken) return;
    const tokenHash = this.hashToken(refreshToken);
    const now = new Date();
    const current = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!current) return;
    await this.prisma.refreshToken.updateMany({
      where: { id: current.id, revokedAt: null },
      data: { revokedAt: now, lastUsedAt: now },
    });
    await this.audit.record({
      actorId: context.actorId ?? current.userId,
      action: 'AUTH_LOGOUT',
      resourceType: 'RefreshToken',
      resourceId: current.id,
      requestId: context.requestId,
      metadata: { outcome: 'revoked' },
    });
  }

  async revokeAllForUser(
    userId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private toPublicUser(user: {
    id: string;
    username: string;
    role: PublicUser['role'];
    status: PublicUser['status'];
  }): PublicUser {
    return { id: user.id, username: user.username, role: user.role, status: user.status };
  }

  private async recordRejectedRefresh(
    context: { requestId?: string },
    reason: string,
  ): Promise<void> {
    await this.audit
      .record({
        action: 'AUTH_REFRESH_REJECTED',
        resourceType: 'RefreshToken',
        resourceId: 'unknown',
        requestId: context.requestId,
        metadata: { outcome: 'rejected', reason: reason === 'internal' ? 'invalid' : reason },
      })
      .catch(() => undefined);
  }
}
