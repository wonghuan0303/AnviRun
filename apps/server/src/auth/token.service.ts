import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { isUserRole } from '@buildplatform/contracts';

import { ApiException } from '../common/api-exception';
import { AuthConfigService } from '../config/auth.config';
import type { AccessTokenClaims } from './auth.types';

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

@Injectable()
export class TokenService {
  constructor(private readonly authConfig: AuthConfigService) {}

  issueAccessToken(input: {
    userId: string;
    role: AccessTokenClaims['role'];
    tokenVersion: number;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    const config = this.authConfig.values;
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload: AccessTokenClaims = {
      sub: input.userId,
      role: input.role,
      tokenVersion: input.tokenVersion,
      jti: randomUUID(),
      typ: 'access',
      iat: now,
      exp: now + config.accessTokenTtlSeconds,
      iss: config.tokenIssuer,
      aud: config.tokenAudience,
    };
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    return `${signingInput}.${sign(signingInput, config.accessTokenSecret)}`;
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const config = this.authConfig.values;
    const parts = token.split('.');
    if (parts.length !== 3) throw new ApiException('AUTH_TOKEN_EXPIRED');

    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(base64UrlDecode(parts[0]));
      payload = JSON.parse(base64UrlDecode(parts[1]));
    } catch {
      throw new ApiException('AUTH_TOKEN_EXPIRED');
    }

    if (
      typeof header !== 'object' ||
      header === null ||
      !('alg' in header) ||
      !('typ' in header) ||
      header.alg !== 'HS256' ||
      header.typ !== 'JWT'
    ) {
      throw new ApiException('AUTH_TOKEN_EXPIRED');
    }

    const expectedSignature = sign(`${parts[0]}.${parts[1]}`, config.accessTokenSecret);
    const suppliedSignature = Buffer.from(parts[2]);
    const expected = Buffer.from(expectedSignature);
    if (
      suppliedSignature.length !== expected.length ||
      !timingSafeEqual(suppliedSignature, expected)
    ) {
      throw new ApiException('AUTH_TOKEN_EXPIRED');
    }

    if (!this.isClaims(payload)) throw new ApiException('AUTH_TOKEN_EXPIRED');
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) throw new ApiException('AUTH_TOKEN_EXPIRED');
    if (
      payload.iss !== config.tokenIssuer ||
      payload.aud !== config.tokenAudience ||
      payload.typ !== 'access' ||
      payload.iat > now + 60
    ) {
      throw new ApiException('AUTH_TOKEN_EXPIRED');
    }

    return payload;
  }

  private isClaims(value: unknown): value is AccessTokenClaims {
    if (typeof value !== 'object' || value === null) return false;
    const claims = value as Record<string, unknown>;

    return (
      typeof claims.sub === 'string' &&
      isUserRole(claims.role) &&
      Number.isInteger(claims.tokenVersion) &&
      typeof claims.jti === 'string' &&
      claims.jti.length > 0 &&
      claims.typ === 'access' &&
      Number.isSafeInteger(claims.iat) &&
      Number.isSafeInteger(claims.exp) &&
      typeof claims.iss === 'string' &&
      typeof claims.aud === 'string'
    );
  }
}
