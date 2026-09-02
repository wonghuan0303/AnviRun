import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type AuthCookieSameSite = 'strict' | 'lax';

export interface AuthConfigValues {
  accessTokenSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  refreshTokenHashSecret: string;
  tokenIssuer: string;
  tokenAudience: string;
  cookieSecure: boolean;
  cookieSameSite: AuthCookieSameSite;
  cookieName: string;
  csrfCookieName: string;
  cookiePath: string;
  csrfCookiePath: string;
  allowInsecureHttp: boolean;
  insecureHttpMode: boolean;
  loginRateLimitWindowMs: number;
  loginRateLimitMax: number;
  nodeEnv: string;
}

const DEV_ACCESS_SECRET = 'buildplatform-dev-only-access-token-secret-change-me';
const TEST_ACCESS_SECRET = 'buildplatform-test-fixed-access-token-secret-only';
const DEV_REFRESH_SECRET = 'buildplatform-dev-only-refresh-hash-secret-change-me';
const TEST_REFRESH_SECRET = 'buildplatform-test-fixed-refresh-hash-secret-only';

function parseDuration(value: string | undefined, fallbackSeconds: number): number {
  if (!value?.trim()) return fallbackSeconds;
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[
    match[2].toLowerCase() as 's' | 'm' | 'h' | 'd'
  ];
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error(`invalid duration: ${value}`);
  return seconds;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (!value?.trim()) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function isExampleSecret(secret: string): boolean {
  const normalized = secret.toLowerCase();
  const uniqueCharacters = new Set(secret).size;
  return (
    secret.length < 32 ||
    uniqueCharacters < 8 ||
    /^(.)\1+$/.test(secret) ||
    normalized.includes('change-me') ||
    normalized.includes('change_me') ||
    normalized.includes('example') ||
    normalized.includes('placeholder') ||
    normalized.includes('dev-only') ||
    normalized.includes('test-fixed') ||
    normalized.includes('buildplatform')
  );
}

export function resolveAuthConfig(env: Record<string, string | undefined>): AuthConfigValues {
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const production = nodeEnv === 'production';
  const allowInsecureHttp = parseBoolean(env.ALLOW_INSECURE_HTTP, false, 'ALLOW_INSECURE_HTTP');
  const accessTokenSecret =
    env.ACCESS_TOKEN_SECRET?.trim() ||
    (nodeEnv === 'test' ? TEST_ACCESS_SECRET : DEV_ACCESS_SECRET);
  const refreshTokenHashSecret =
    env.REFRESH_TOKEN_HASH_SECRET?.trim() ||
    (nodeEnv === 'test' ? TEST_REFRESH_SECRET : DEV_REFRESH_SECRET);

  if (production && !env.ACCESS_TOKEN_SECRET?.trim()) {
    throw new Error('ACCESS_TOKEN_SECRET must be explicitly configured in production');
  }
  if (production && !env.REFRESH_TOKEN_HASH_SECRET?.trim()) {
    throw new Error('REFRESH_TOKEN_HASH_SECRET must be explicitly configured in production');
  }
  if (production && isExampleSecret(accessTokenSecret)) {
    throw new Error('ACCESS_TOKEN_SECRET must be a strong, non-repeating secret in production');
  }
  if (production && isExampleSecret(refreshTokenHashSecret)) {
    throw new Error(
      'REFRESH_TOKEN_HASH_SECRET must be a strong, non-repeating secret in production',
    );
  }
  if (production && accessTokenSecret === refreshTokenHashSecret) {
    throw new Error('production token secrets must be independent');
  }

  const cookieSecure = parseBoolean(env.AUTH_COOKIE_SECURE, production, 'AUTH_COOKIE_SECURE');
  const insecureHttpMode = production && allowInsecureHttp && !cookieSecure;
  if (production && !cookieSecure && !allowInsecureHttp) {
    throw new Error(
      'AUTH_COOKIE_SECURE must be true in production unless ALLOW_INSECURE_HTTP=true is explicitly enabled',
    );
  }

  const cookieSameSite = (env.AUTH_COOKIE_SAME_SITE?.trim().toLowerCase() ||
    'strict') as AuthCookieSameSite;
  if (cookieSameSite !== 'strict' && cookieSameSite !== 'lax') {
    throw new Error('AUTH_COOKIE_SAME_SITE must be strict or lax');
  }
  if (insecureHttpMode && cookieSameSite !== 'strict') {
    throw new Error('insecure production HTTP mode requires AUTH_COOKIE_SAME_SITE=strict');
  }

  const cookieName =
    env.AUTH_COOKIE_NAME?.trim() ||
    (production ? '__Host-buildplatform_refresh' : 'buildplatform_refresh');
  const csrfCookieName =
    env.AUTH_CSRF_COOKIE_NAME?.trim() ||
    (production ? '__Host-buildplatform_csrf' : 'buildplatform_csrf');
  if (
    production &&
    !insecureHttpMode &&
    (!cookieName.startsWith('__Host-') || !csrfCookieName.startsWith('__Host-'))
  ) {
    throw new Error('production auth cookies must use __Host- names');
  }
  if (
    insecureHttpMode &&
    (cookieName.startsWith('__Host-') || csrfCookieName.startsWith('__Host-'))
  ) {
    throw new Error('insecure production HTTP mode requires non-__Host- cookie names');
  }
  if (production && env.AUTH_COOKIE_DOMAIN?.trim()) {
    throw new Error('AUTH_COOKIE_DOMAIN is not supported for production auth cookies');
  }

  return {
    accessTokenSecret,
    accessTokenTtlSeconds: parseDuration(env.ACCESS_TOKEN_TTL, 900),
    refreshTokenTtlSeconds: parseDuration(env.REFRESH_TOKEN_TTL, 604800),
    refreshTokenHashSecret,
    tokenIssuer: env.TOKEN_ISSUER?.trim() || 'buildplatform-server',
    tokenAudience: env.TOKEN_AUDIENCE?.trim() || 'buildplatform-web',
    cookieSecure,
    cookieSameSite,
    cookieName,
    csrfCookieName,
    cookiePath: production ? '/' : '/api/auth',
    csrfCookiePath: '/',
    allowInsecureHttp,
    insecureHttpMode,
    loginRateLimitWindowMs: parseDuration(env.LOGIN_RATE_LIMIT_WINDOW, 300) * 1000,
    loginRateLimitMax: parsePositiveInteger(env.LOGIN_RATE_LIMIT_MAX, 5, 'LOGIN_RATE_LIMIT_MAX'),
    nodeEnv,
  };
}

@Injectable()
export class AuthConfigService {
  readonly values: AuthConfigValues;

  constructor(configService: ConfigService) {
    this.values = resolveAuthConfig({
      NODE_ENV: configService.get<string>('NODE_ENV'),
      ACCESS_TOKEN_SECRET: configService.get<string>('ACCESS_TOKEN_SECRET'),
      ACCESS_TOKEN_TTL: configService.get<string>('ACCESS_TOKEN_TTL'),
      REFRESH_TOKEN_TTL: configService.get<string>('REFRESH_TOKEN_TTL'),
      REFRESH_TOKEN_HASH_SECRET: configService.get<string>('REFRESH_TOKEN_HASH_SECRET'),
      TOKEN_ISSUER: configService.get<string>('TOKEN_ISSUER'),
      TOKEN_AUDIENCE: configService.get<string>('TOKEN_AUDIENCE'),
      AUTH_COOKIE_SECURE: configService.get<string>('AUTH_COOKIE_SECURE'),
      AUTH_COOKIE_SAME_SITE: configService.get<string>('AUTH_COOKIE_SAME_SITE'),
      AUTH_COOKIE_NAME: configService.get<string>('AUTH_COOKIE_NAME'),
      AUTH_CSRF_COOKIE_NAME: configService.get<string>('AUTH_CSRF_COOKIE_NAME'),
      ALLOW_INSECURE_HTTP: configService.get<string>('ALLOW_INSECURE_HTTP'),
      AUTH_COOKIE_DOMAIN: configService.get<string>('AUTH_COOKIE_DOMAIN'),
      LOGIN_RATE_LIMIT_WINDOW: configService.get<string>('LOGIN_RATE_LIMIT_WINDOW'),
      LOGIN_RATE_LIMIT_MAX: configService.get<string>('LOGIN_RATE_LIMIT_MAX'),
    });
  }
}
