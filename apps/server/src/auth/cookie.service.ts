import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';

import { AuthConfigService } from '../config/auth.config';

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name) result[name] = decodeCookieValue(value);
  }
  return result;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

@Injectable()
export class CookieService {
  constructor(private readonly authConfig: AuthConfigService) {}

  createRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  createCsrfToken(): string {
    return randomBytes(32).toString('base64url');
  }

  getRefreshToken(request: {
    headers?: Record<string, string | string[] | undefined>;
  }): string | undefined {
    const header = request.headers?.cookie;
    return parseCookies(Array.isArray(header) ? header.join(';') : header)[
      this.authConfig.values.cookieName
    ];
  }

  getCsrfCookie(request: {
    headers?: Record<string, string | string[] | undefined>;
  }): string | undefined {
    const header = request.headers?.cookie;
    return parseCookies(Array.isArray(header) ? header.join(';') : header)[
      this.authConfig.values.csrfCookieName
    ];
  }

  setAuthCookies(response: Response, refreshToken: string, csrfToken: string): void {
    response.cookie(this.authConfig.values.cookieName, refreshToken, this.options(true));
    response.cookie(this.authConfig.values.csrfCookieName, csrfToken, this.options(false));
  }

  clearAuthCookies(response: Response): void {
    response.clearCookie(this.authConfig.values.cookieName, this.options(true));
    response.clearCookie(this.authConfig.values.csrfCookieName, this.options(false));
  }

  private options(httpOnly: boolean): CookieOptions {
    const config = this.authConfig.values;
    return {
      httpOnly,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      path: config.cookiePath,
      maxAge: config.refreshTokenTtlSeconds * 1000,
    };
  }
}
