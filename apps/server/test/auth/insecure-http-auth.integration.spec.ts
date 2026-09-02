import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { PasswordService } from '../../src/auth/password.service';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PrismaService } from '../../src/database/prisma.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Production HTTP auth integration tests require buildplatform_test');
}

jest.setTimeout(30_000);

function cookieValue(cookies: string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`missing cookie ${name}`);
  return cookie.slice(name.length + 1).split(';')[0];
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((value) => value.split(';')[0]).join('; ');
}

describe('production trusted-intranet HTTP authentication', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const password = 'Production HTTP smoke password 🔐';

  async function resetDatabase(): Promise<void> {
    await prisma.agent.updateMany({ data: { activeTaskId: null } });
    await prisma.artifact.deleteMany();
    await prisma.buildTask.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.project.deleteMany();
    await prisma.buildTemplate.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.user.deleteMany();
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_INSECURE_HTTP = 'true';
    process.env.AUTH_COOKIE_SECURE = 'false';
    process.env.AUTH_COOKIE_SAME_SITE = 'strict';
    process.env.AUTH_COOKIE_NAME = 'buildplatform_refresh';
    process.env.AUTH_CSRF_COOKIE_NAME = 'buildplatform_csrf';
    process.env.ACCESS_TOKEN_SECRET = 'A-http-production-secret-with-strong-entropy-4821!';
    process.env.REFRESH_TOKEN_HASH_SECRET = 'B-http-production-secret-with-strong-entropy-7392$';

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    await prisma.user.create({
      data: {
        username: 'http-admin',
        passwordHash: await passwords.hash(password),
        role: 'ADMIN',
      },
    });
    app.get(LoginRateLimiterService).reset();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ALLOW_INSECURE_HTTP;
    delete process.env.AUTH_COOKIE_SECURE;
    delete process.env.AUTH_COOKIE_SAME_SITE;
    delete process.env.AUTH_COOKIE_NAME;
    delete process.env.AUTH_CSRF_COOKIE_NAME;
    delete process.env.ACCESS_TOKEN_SECRET;
    delete process.env.REFRESH_TOKEN_HASH_SECRET;
  });

  it('completes login, refresh, me and logout over HTTP with CSRF-protected non-Secure cookies', async () => {
    const loggedIn = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'http-admin', password });
    expect(loggedIn.status).toBe(200);

    const loginCookies = loggedIn.headers['set-cookie'] as unknown as string[];
    expect(loginCookies).toHaveLength(2);
    expect(loginCookies.every((value) => !value.includes('Secure'))).toBe(true);
    expect(loginCookies.every((value) => !value.startsWith('__Host-'))).toBe(true);
    expect(loginCookies.every((value) => value.includes('SameSite=Strict'))).toBe(true);
    expect(loginCookies.every((value) => value.includes('Path=/'))).toBe(true);
    expect(loginCookies.some((value) => value.includes('HttpOnly'))).toBe(true);
    expect(
      loginCookies.some(
        (value) => value.startsWith('buildplatform_csrf=') && value.includes('HttpOnly'),
      ),
    ).toBe(false);

    const csrf = cookieValue(loginCookies, 'buildplatform_csrf');
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.accessToken}`);
    expect(me.status).toBe(200);

    const refreshed = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(loginCookies))
      .set('X-CSRF-Token', csrf);
    expect(refreshed.status).toBe(200);
    const refreshedCookies = refreshed.headers['set-cookie'] as unknown as string[];
    expect(refreshedCookies.every((value) => !value.includes('Secure'))).toBe(true);
    expect(refreshedCookies.every((value) => value.includes('SameSite=Strict'))).toBe(true);
    expect(refreshedCookies.every((value) => value.includes('Path=/'))).toBe(true);

    const refreshedCsrf = cookieValue(refreshedCookies, 'buildplatform_csrf');
    const loggedOut = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', cookieHeader(refreshedCookies))
      .set('X-CSRF-Token', refreshedCsrf);
    expect(loggedOut.status).toBe(200);
    const clearedCookies = loggedOut.headers['set-cookie'] as unknown as string[];
    expect(clearedCookies.every((value) => value.includes('Path=/'))).toBe(true);
    expect(clearedCookies.every((value) => !value.includes('Secure'))).toBe(true);
    expect(clearedCookies.every((value) => value.includes('SameSite=Strict'))).toBe(true);
  });
});
