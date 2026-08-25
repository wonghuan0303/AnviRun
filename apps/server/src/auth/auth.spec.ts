import { resolveAuthConfig } from '../config/auth.config';
import { CookieService } from './cookie.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

describe('T1.2 auth primitives', () => {
  it('requires two explicit independent high-complexity production secrets', () => {
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: 'production',
        AUTH_COOKIE_SECURE: 'true',
      }),
    ).toThrow(/explicitly configured/);
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: 'production',
        ACCESS_TOKEN_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        REFRESH_TOKEN_HASH_SECRET: 'different-refresh-secret-value-1234567890',
        AUTH_COOKIE_SECURE: 'true',
      }),
    ).toThrow(/strong/);
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: 'production',
        ACCESS_TOKEN_SECRET: 'Access-token-production-key-1234567890!@#',
        REFRESH_TOKEN_HASH_SECRET: 'Access-token-production-key-1234567890!@#',
        AUTH_COOKIE_SECURE: 'true',
      }),
    ).toThrow(/independent/);
  });

  it('rejects example production secrets', () => {
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: 'production',
        ACCESS_TOKEN_SECRET: 'production-access-token-example-1234567890',
        REFRESH_TOKEN_HASH_SECRET: 'Refresh-hash-production-key-9876543210$%^',
        AUTH_COOKIE_SECURE: 'true',
      }),
    ).toThrow(/strong/);
  });
  it('configures production __Host- cookies with the required attributes', () => {
    const config = resolveAuthConfig({
      NODE_ENV: 'production',
      ACCESS_TOKEN_SECRET: 'Access-token-production-key-1234567890!@#',
      REFRESH_TOKEN_HASH_SECRET: 'Refresh-hash-production-key-9876543210$%^',
      AUTH_COOKIE_SECURE: 'true',
    });
    expect(config.cookieName).toMatch(/^__Host-/);
    expect(config.csrfCookieName).toMatch(/^__Host-/);
    expect(config.cookieSecure).toBe(true);
    expect(config.cookiePath).toBe('/');
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
    const cookies = new CookieService({ values: config });
    cookies.setAuthCookies(response as never, 'refresh-value', 'csrf-value');
    const refreshOptions = response.cookie.mock.calls[0][2] as Record<string, unknown>;
    const csrfOptions = response.cookie.mock.calls[1][2] as Record<string, unknown>;
    expect(refreshOptions).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
    expect(csrfOptions).toMatchObject({
      httpOnly: false,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
    expect(Object.hasOwn(refreshOptions, 'domain')).toBe(false);
    expect(Object.hasOwn(csrfOptions, 'domain')).toBe(false);
    cookies.clearAuthCookies(response as never);
    expect(response.clearCookie.mock.calls[0][1]).toEqual(refreshOptions);
    expect(response.clearCookie.mock.calls[1][1]).toEqual(csrfOptions);
  });

  it('parses auth durations and rejects unsafe cookie configuration', () => {
    const config = resolveAuthConfig({
      NODE_ENV: 'test',
      ACCESS_TOKEN_TTL: '10m',
      REFRESH_TOKEN_TTL: '2d',
      LOGIN_RATE_LIMIT_WINDOW: '30s',
      LOGIN_RATE_LIMIT_MAX: '3',
    });
    expect(config.accessTokenTtlSeconds).toBe(600);
    expect(config.refreshTokenTtlSeconds).toBe(172800);
    expect(config.loginRateLimitWindowMs).toBe(30000);
    expect(config.loginRateLimitMax).toBe(3);
    expect(() =>
      resolveAuthConfig({ NODE_ENV: 'test', AUTH_COOKIE_SECURE: 'sometimes' }),
    ).toThrow();
  });

  it('hashes passwords with Argon2id and verifies Unicode passwords', async () => {
    const passwords = new PasswordService();
    const hash = await passwords.hash('这是一个满足十五字符要求的长密码 🔐');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('这是一个足够长的密码');
    await expect(passwords.verify(hash, '这是一个满足十五字符要求的长密码 🔐')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'wrong password')).resolves.toBe(false);
  });

  it('issues and verifies access token claims and rejects tampering', () => {
    const config = resolveAuthConfig({ NODE_ENV: 'test' });
    const tokens = new TokenService({ values: config });
    const token = tokens.issueAccessToken({ userId: 'user-1', role: 'ADMIN', tokenVersion: 4 });
    const claims = tokens.verifyAccessToken(token);
    expect(claims).toMatchObject({ sub: 'user-1', role: 'ADMIN', tokenVersion: 4, typ: 'access' });
    expect(claims.iss).toBe(config.tokenIssuer);
    expect(claims.aud).toBe(config.tokenAudience);
    expect(claims.exp - claims.iat).toBe(config.accessTokenTtlSeconds);
    expect(() => tokens.verifyAccessToken(`${token.slice(0, -1)}x`)).toThrow('登录状态已过期');
  });

  it('rejects an expired access token', () => {
    const config = resolveAuthConfig({ NODE_ENV: 'test', ACCESS_TOKEN_TTL: '1s' });
    const tokens = new TokenService({ values: config });
    const token = tokens.issueAccessToken({ userId: 'user-1', role: 'USER', tokenVersion: 0 });
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 2_000);
    try {
      expect(() => tokens.verifyAccessToken(token)).toThrow('登录状态已过期');
    } finally {
      clock.mockRestore();
    }
  });
});
