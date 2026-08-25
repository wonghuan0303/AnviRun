import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { UserStatus } from '@prisma/client';

import { ApiException } from '../common/api-exception';
import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedRequest } from './auth.types';
import { TokenService } from './token.service';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const authorization = Array.isArray(header) ? header[0] : header;
    if (!authorization?.startsWith('Bearer ')) throw new ApiException('AUTH_TOKEN_EXPIRED');

    const token = authorization.slice('Bearer '.length).trim();
    const claims = this.tokens.verifyAccessToken(token);
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, username: true, role: true, status: true, tokenVersion: true },
    });
    if (!user || user.tokenVersion !== claims.tokenVersion)
      throw new ApiException('AUTH_TOKEN_EXPIRED');
    if (user.status === UserStatus.DISABLED) throw new ApiException('AUTH_ACCOUNT_DISABLED');

    request.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      tokenVersion: user.tokenVersion,
      jti: claims.jti,
    };
    return true;
  }
}
