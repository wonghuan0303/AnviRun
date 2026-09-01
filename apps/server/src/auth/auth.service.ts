import { Injectable } from '@nestjs/common';
import { UserStatus } from '@prisma/client';

import { ApiException } from '../common/api-exception';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { normalizeUsername } from '../database/username';
import { AuthConfigService } from '../config/auth.config';
import type { PublicUser } from './auth.types';
import { PasswordService } from './password.service';
import { LoginRateLimiterService } from './rate-limiter.service';
import { RefreshSessionService } from './refresh-session.service';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  user: PublicUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: RefreshSessionService,
    private readonly limiter: LoginRateLimiterService,
    private readonly audit: AuditService,
    private readonly authConfig: AuthConfigService,
  ) {}

  async login(input: {
    username: string;
    password: string;
    ip?: string;
    userAgent?: string;
    requestId?: string;
  }): Promise<LoginResult> {
    const normalizedUsername = this.safeNormalizeUsername(input.username);
    const ip = input.ip || 'unknown';
    try {
      this.limiter.assertAllowed(ip, normalizedUsername);
    } catch (error) {
      await this.recordLoginFailure(input.requestId);
      throw error;
    }

    const user = normalizedUsername
      ? await this.prisma.user.findUnique({ where: { username: normalizedUsername } })
      : null;
    const hash = user?.passwordHash ?? (await this.passwords.dummyHash());
    const passwordMatches = await this.passwords.verify(hash, input.password);

    if (!passwordMatches || !user) {
      this.limiter.recordFailure(ip, normalizedUsername);
      await this.recordLoginFailure(input.requestId);
      throw new ApiException('AUTH_INVALID_CREDENTIALS');
    }
    if (user.status === UserStatus.DISABLED) {
      this.limiter.recordFailure(ip, normalizedUsername);
      await this.recordLoginFailure(input.requestId);
      throw new ApiException('AUTH_ACCOUNT_DISABLED');
    }

    const expectedTokenVersion = user.tokenVersion;
    const publicUser = this.toPublicUser(user);
    let session: LoginResult;
    try {
      session = await this.sessions.create(publicUser, input, expectedTokenVersion);
    } catch (error) {
      this.limiter.recordFailure(ip, normalizedUsername);
      await this.recordLoginFailure(input.requestId);
      throw error;
    }
    this.limiter.recordSuccess(ip, normalizedUsername);
    await this.audit.record({
      actorId: user.id,
      action: 'AUTH_LOGIN_SUCCEEDED',
      resourceType: 'User',
      resourceId: user.id,
      requestId: input.requestId,
      metadata: { outcome: 'success' },
    });
    return session;
  }

  async refresh(input: {
    refreshToken?: string;
    ip?: string;
    userAgent?: string;
    requestId?: string;
  }): Promise<LoginResult> {
    return this.sessions.rotate(input.refreshToken, input);
  }

  async logout(input: {
    refreshToken?: string;
    requestId?: string;
    actorId?: string;
  }): Promise<void> {
    await this.sessions.revoke(input.refreshToken, input);
  }

  getAccessTokenTtlSeconds(): number {
    return this.authConfig.values.accessTokenTtlSeconds;
  }

  private safeNormalizeUsername(username: string): string {
    try {
      return normalizeUsername(username);
    } catch {
      return username.trim().toLowerCase().slice(0, 256);
    }
  }

  async recordLoginFailure(requestId?: string): Promise<void> {
    await this.audit
      .record({
        action: 'AUTH_LOGIN_FAILED',
        resourceType: 'User',
        resourceId: 'unknown',
        requestId,
        result: 'FAILURE',
        metadata: { outcome: 'rejected' },
      })
      .catch(() => undefined);
  }

  private toPublicUser(user: {
    id: string;
    username: string;
    role: PublicUser['role'];
    status: PublicUser['status'];
  }): PublicUser {
    return { id: user.id, username: user.username, role: user.role, status: user.status };
  }
}
