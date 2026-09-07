import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { initializeFirstAdmin } from '../../src/cli/init-admin';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PasswordService } from '../../src/auth/password.service';
import { PrismaService } from '../../src/database/prisma.service';
import { RefreshSessionService } from '../../src/auth/refresh-session.service';
import { UsersService } from '../../src/users/users.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Authentication integration tests require buildplatform_test');
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

describe('T1.2 authentication PostgreSQL/API integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminId: string;
  let adminPassword: string;

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

  async function login(username = 'admin', password = adminPassword) {
    return request(app.getHttpServer()).post('/api/auth/login').send({ username, password });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    adminPassword = 'Admin password with Unicode 🔐';
    const user = await prisma.user.create({
      data: {
        username: 'admin',
        passwordHash: await passwords.hash(adminPassword),
        role: 'ADMIN',
      },
    });
    adminId = user.id;
    app.get(LoginRateLimiterService).reset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs in with normalized username and sets secure refresh/CSRF cookies', async () => {
    const response = await login(' ADMIN ', adminPassword);
    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({
      id: adminId,
      username: 'admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    expect(response.body.accessToken).toEqual(expect.any(String));
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((value) => value.startsWith('buildplatform_refresh='))).toBe(true);
    expect(cookies.some((value) => value.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((value) => value.includes('Path=/api/auth'))).toBe(true);
    expect(cookies.some((value) => value.includes('SameSite=Strict'))).toBe(true);
    expect(cookies.some((value) => value.startsWith('buildplatform_csrf='))).toBe(true);
    expect(
      cookies.some((value) => value.startsWith('buildplatform_csrf=') && value.includes('Path=/')),
    ).toBe(true);
    expect(
      cookies.some(
        (value) => value.includes('HttpOnly') && value.startsWith('buildplatform_csrf='),
      ),
    ).toBe(false);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('uses the same public error response for unknown username and wrong password', async () => {
    const unknown = await login('missing-user', adminPassword);
    const wrong = await login('admin', 'not the right password');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: '用户名或密码错误',
    });
    expect(wrong.body).toEqual(unknown.body);
    expect(JSON.stringify(unknown.body)).not.toContain('missing-user');
  });

  it('rejects disabled users and records safe audit metadata', async () => {
    const passwords = new PasswordService();
    await prisma.user.create({
      data: {
        username: 'disabled-user',
        passwordHash: await passwords.hash(adminPassword),
        status: 'DISABLED',
      },
    });
    const response = await login('disabled-user', adminPassword);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_ACCOUNT_DISABLED');
    const logs = await prisma.auditLog.findMany({ where: { action: 'AUTH_LOGIN_FAILED' } });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(adminPassword);
    expect(JSON.stringify(logs)).not.toContain('passwordHash');
  });

  it('protects me with a signed access token and tokenVersion', async () => {
    const loggedIn = await login();
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: adminId, username: 'admin', role: 'ADMIN', status: 'ACTIVE' });
    expect(JSON.stringify(me.body)).not.toContain('tokenVersion');
    expect((await request(app.getHttpServer()).get('/api/auth/me')).body.code).toBe(
      'AUTH_TOKEN_EXPIRED',
    );

    await prisma.user.update({ where: { id: adminId }, data: { tokenVersion: { increment: 1 } } });
    const stale = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loggedIn.body.accessToken}`);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('rotates refresh tokens and allows at most one concurrent reuse', async () => {
    const loggedIn = await login();
    const cookies = loggedIn.headers['set-cookie'] as unknown as string[];
    const oldCookie = cookieHeader(cookies);
    const csrf = cookieValue(cookies, 'buildplatform_csrf');
    const first = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', oldCookie)
      .set('X-CSRF-Token', csrf);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(await prisma.refreshToken.count({ where: { revokedAt: { not: null } } })).toBe(1);

    const reused = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', oldCookie)
      .set('X-CSRF-Token', csrf);
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('AUTH_TOKEN_EXPIRED');

    const secondLogin = await login();
    const secondCookies = secondLogin.headers['set-cookie'] as unknown as string[];
    const secondCookie = cookieHeader(secondCookies);
    const secondCsrf = cookieValue(secondCookies, 'buildplatform_csrf');
    const concurrent = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', secondCookie)
        .set('X-CSRF-Token', secondCsrf),
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', secondCookie)
        .set('X-CSRF-Token', secondCsrf),
    ]);
    expect(concurrent.filter((response) => response.status === 200)).toHaveLength(1);
    expect(concurrent.filter((response) => response.status === 401)).toHaveLength(1);
  });

  it('rejects expired and revoked refresh tokens', async () => {
    const expiredLogin = await login();
    const expiredCookies = expiredLogin.headers['set-cookie'] as unknown as string[];
    const expiredRefresh = cookieValue(expiredCookies, 'buildplatform_refresh');
    const expiredCsrf = cookieValue(expiredCookies, 'buildplatform_csrf');
    const hash = app.get(RefreshSessionService).hashToken(expiredRefresh);
    await prisma.refreshToken.update({
      where: { tokenHash: hash },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(expiredCookies))
      .set('X-CSRF-Token', expiredCsrf);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('AUTH_TOKEN_EXPIRED');

    const revokedLogin = await login();
    const revokedCookies = revokedLogin.headers['set-cookie'] as unknown as string[];
    const revokedCsrf = cookieValue(revokedCookies, 'buildplatform_csrf');
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', cookieHeader(revokedCookies))
      .set('X-CSRF-Token', revokedCsrf);
    const revoked = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(revokedCookies))
      .set('X-CSRF-Token', revokedCsrf);
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('does not leave a usable login session across concurrent password reset', async () => {
    const admin = await login();
    const oldPassword = 'Old login reset race password 🔑';
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', 'Bearer ' + admin.body.accessToken)
      .send({ username: 'login-reset-race-user', password: oldPassword });
    const userId = created.body.id as string;
    const loginPromise = login('login-reset-race-user', oldPassword);
    const resetPromise = request(app.getHttpServer())
      .post('/api/admin/users/' + userId + '/reset-password')
      .set('Authorization', 'Bearer ' + admin.body.accessToken)
      .send({ password: 'New login reset race password 🔑' });

    const [loginResponse, resetResponse] = await Promise.all([loginPromise, resetPromise]);
    expect(resetResponse.status).toBe(200);

    const storedTokens = await prisma.refreshToken.findMany({ where: { userId } });
    expect(storedTokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(storedTokens.filter((token) => token.revokedAt === null)).toHaveLength(0);
    if (loginResponse.status === 200) {
      const me = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer ' + loginResponse.body.accessToken);
      expect(me.status).toBe(401);
      expect(me.body.code).toBe('AUTH_TOKEN_EXPIRED');
      const cookies = loginResponse.headers['set-cookie'] as unknown as string[];
      const refreshToken = cookieValue(cookies, 'buildplatform_refresh');
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: app.get(RefreshSessionService).hashToken(refreshToken) },
      });
      expect(stored?.revokedAt).not.toBeNull();
    } else {
      expect([401, 403]).toContain(loginResponse.status);
      expect(loginResponse.body.accessToken).toBeUndefined();
    }
  });

  it('does not leave a usable login session across concurrent disable', async () => {
    const admin = await login();
    const password = 'Login disable race password 🔑';
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', 'Bearer ' + admin.body.accessToken)
      .send({ username: 'login-disable-race-user', password });
    const userId = created.body.id as string;
    const loginPromise = login('login-disable-race-user', password);
    const disablePromise = request(app.getHttpServer())
      .patch('/api/admin/users/' + userId + '/disable')
      .set('Authorization', 'Bearer ' + admin.body.accessToken);

    const [loginResponse, disableResponse] = await Promise.all([loginPromise, disablePromise]);
    expect(disableResponse.status).toBe(200);
    expect(disableResponse.body.status).toBe('DISABLED');

    const storedTokens = await prisma.refreshToken.findMany({ where: { userId } });
    expect(storedTokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(storedTokens.filter((token) => token.revokedAt === null)).toHaveLength(0);
    if (loginResponse.status === 200) {
      const me = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer ' + loginResponse.body.accessToken);
      expect(me.status).toBe(401);
      expect(me.body.code).toBe('AUTH_TOKEN_EXPIRED');
      const cookies = loginResponse.headers['set-cookie'] as unknown as string[];
      const refreshToken = cookieValue(cookies, 'buildplatform_refresh');
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: app.get(RefreshSessionService).hashToken(refreshToken) },
      });
      expect(stored?.revokedAt).not.toBeNull();
    } else {
      expect([401, 403]).toContain(loginResponse.status);
      expect(loginResponse.body.accessToken).toBeUndefined();
    }
  });
  it('serializes password reset before refresh rotation and revokes the entire old chain', async () => {
    const admin = await login();
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ` + admin.body.accessToken)
      .send({ username: 'reset-race-user', password: 'Old reset race password 🔑' });
    const userId = created.body.id as string;
    const userLogin = await login('reset-race-user', 'Old reset race password 🔑');
    const cookies = userLogin.headers['set-cookie'] as unknown as string[];
    const refreshToken = cookieValue(cookies, 'buildplatform_refresh');
    const sessions = app.get(RefreshSessionService);
    const users = app.get(UsersService);

    const results = await Promise.allSettled([
      sessions.rotate(refreshToken, { requestId: 'race-refresh-reset' }),
      users.resetPassword(adminId, userId, 'New reset race password 🔑', 'race-reset'),
    ]);
    const resetResult = results[1];
    expect(resetResult.status).toBe('fulfilled');
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0);

    const refreshResult = results[0];
    if (refreshResult.status === 'fulfilled') {
      const freshAccess = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${refreshResult.value.accessToken}`);
      expect(freshAccess.status).toBe(401);
      expect(freshAccess.body.code).toBe('AUTH_TOKEN_EXPIRED');
      await expect(sessions.rotate(refreshResult.value.refreshToken, {})).rejects.toMatchObject({
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }
  });

  it('serializes disable before refresh rotation without leaving a usable session', async () => {
    const admin = await login();
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ` + admin.body.accessToken)
      .send({ username: 'disable-race-user', password: 'Disable race password 🔑' });
    const userId = created.body.id as string;
    const userLogin = await login('disable-race-user', 'Disable race password 🔑');
    const cookies = userLogin.headers['set-cookie'] as unknown as string[];
    const refreshToken = cookieValue(cookies, 'buildplatform_refresh');
    const sessions = app.get(RefreshSessionService);
    const users = app.get(UsersService);

    const results = await Promise.allSettled([
      sessions.rotate(refreshToken, { requestId: 'race-refresh-disable' }),
      users.disableUser(adminId, userId, 'race-disable'),
    ]);
    const disableResult = results[1];
    if (disableResult.status !== 'fulfilled') throw disableResult.reason;
    expect(disableResult.value.status).toBe('DISABLED');
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status).toBe(
      'DISABLED',
    );

    const refreshResult = results[0];
    if (refreshResult.status === 'fulfilled') {
      const freshAccess = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${refreshResult.value.accessToken}`);
      expect(freshAccess.status).toBe(401);
      expect(freshAccess.body.code).toBe('AUTH_TOKEN_EXPIRED');
      await expect(sessions.rotate(refreshResult.value.refreshToken, {})).rejects.toMatchObject({
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }
  });
  it('requires CSRF for refresh/logout, while repeated logout remains idempotent', async () => {
    const loggedIn = await login();
    const cookies = loggedIn.headers['set-cookie'] as unknown as string[];
    const cookie = cookieHeader(cookies);
    const csrf = cookieValue(cookies, 'buildplatform_csrf');
    const missingCsrf = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookie);
    expect(missingCsrf.status).toBe(401);
    const logout = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf);
    expect(logout.status).toBe(200);
    expect(await prisma.refreshToken.count({ where: { revokedAt: { not: null } } })).toBe(1);
    const repeated = await request(app.getHttpServer()).post('/api/auth/logout');
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual({ ok: true });
  });

  it('lets admins create users but blocks ordinary users from admin APIs', async () => {
    const admin = await login();
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ username: 'new-user', password: 'New user password 🔑', role: 'USER' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual(
      expect.objectContaining({ username: 'new-user', role: 'USER', status: 'ACTIVE' }),
    );
    expect(JSON.stringify(created.body)).not.toContain('passwordHash');
    const duplicate = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ username: ' NEW-USER ', password: 'Another password 🔑' });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body).toMatchObject({ code: 'VALIDATION_FAILED', message: '用户名已存在' });

    const ordinary = await prisma.user.create({
      data: {
        username: 'ordinary',
        passwordHash: await new PasswordService().hash('ordinary password 🔑'),
      },
    });
    const ordinaryLogin = await login('ordinary', 'ordinary password 🔑');
    const forbidden = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${ordinaryLogin.body.accessToken}`)
      .send({ username: 'blocked-user', password: 'Blocked password 🔑' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');
    expect(ordinary.id).toBeDefined();
  });

  it('lists users with stable pagination, filters, all-user metrics and safe fields', async () => {
    const admin = await login();
    const createdUser = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ username: 'searchable-user', password: 'Searchable user password 🔑' });
    const createdAdmin = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({
        username: 'searchable-admin',
        password: 'Searchable admin password 🔑',
        role: 'ADMIN',
      });
    await prisma.user.update({
      where: { id: createdUser.body.id },
      data: { status: 'DISABLED' },
    });

    const all = await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .query({ page: 1, pageSize: 2 });
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.metrics).toEqual({ total: 3, active: 2, disabled: 1, admins: 2 });
    expect(all.body.items[0].createdAt).toBeDefined();
    expect(all.body.items[0]).not.toHaveProperty('passwordHash');
    expect(all.body.items[0]).not.toHaveProperty('tokenVersion');
    expect(JSON.stringify(all.body)).not.toMatch(
      /passwordHash|tokenVersion|password|token|Cookie/i,
    );

    const filtered = await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .query({ search: 'SEARCHABLE', role: 'USER', status: 'DISABLED' });
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items.map((item: { username: string }) => item.username)).toEqual([
      'searchable-user',
    ]);
    expect(createdAdmin.body.id).toBeDefined();
  });

  it('blocks every administrator user operation for ordinary users', async () => {
    const admin = await login();
    const target = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ username: 'ordinary-target', password: 'Ordinary target password 🔑' });
    const ordinary = await prisma.user.create({
      data: {
        username: 'ordinary-operator',
        passwordHash: await new PasswordService().hash('Ordinary operator password 🔑'),
      },
    });
    const ordinaryLogin = await login('ordinary-operator', 'Ordinary operator password 🔑');
    const authorization = `Bearer ${ordinaryLogin.body.accessToken}`;

    const responses = await Promise.all([
      request(app.getHttpServer()).get('/api/admin/users').set('Authorization', authorization),
      request(app.getHttpServer())
        .post('/api/admin/users/' + target.body.id + '/enable')
        .set('Authorization', authorization),
      request(app.getHttpServer())
        .patch('/api/admin/users/' + target.body.id + '/disable')
        .set('Authorization', authorization),
      request(app.getHttpServer())
        .post('/api/admin/users/' + target.body.id + '/reset-password')
        .set('Authorization', authorization)
        .send({ password: 'Blocked reset password 🔑' }),
    ]);
    expect(responses.every((response) => response.status === 403)).toBe(true);
    expect(responses.every((response) => response.body.code === 'FORBIDDEN')).toBe(true);
    expect(ordinary.id).toBeDefined();
  });

  it('enables users idempotently without restoring revoked sessions and protects IDs', async () => {
    const admin = await login();
    const password = 'Enable target password 🔑';
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ username: 'enable-target', password });
    const userId = created.body.id as string;
    const userLogin = await login('enable-target', password);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const disabled = await request(app.getHttpServer())
      .patch(`/api/admin/users/${userId}/disable`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`);
    expect(disabled.status).toBe(200);
    const disabledUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(disabledUser.tokenVersion).toBe(before.tokenVersion + 1);
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0);

    const enabled = await request(app.getHttpServer())
      .post(`/api/admin/users/${userId}/enable`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`);
    expect(enabled.status).toBe(200);
    expect(enabled.body.status).toBe('ACTIVE');
    const enabledUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(enabledUser.tokenVersion).toBe(disabledUser.tokenVersion);
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0);

    const repeated = await request(app.getHttpServer())
      .post(`/api/admin/users/${userId}/enable`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`);
    expect(repeated.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).tokenVersion).toBe(
      enabledUser.tokenVersion,
    );
    const stale = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${userLogin.body.accessToken}`);
    expect(stale.status).toBe(401);

    const selfDisable = await request(app.getHttpServer())
      .patch(`/api/admin/users/${adminId}/disable`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`);
    expect(selfDisable.status).toBe(400);
    expect(selfDisable.body.code).toBe('VALIDATION_FAILED');

    const missingId = '00000000-0000-4000-8000-000000000000';
    const notFoundResponses = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/admin/users/${missingId}/enable`)
        .set('Authorization', `Bearer ${admin.body.accessToken}`),
      request(app.getHttpServer())
        .patch(`/api/admin/users/${missingId}/disable`)
        .set('Authorization', `Bearer ${admin.body.accessToken}`),
      request(app.getHttpServer())
        .post(`/api/admin/users/${missingId}/reset-password`)
        .set('Authorization', `Bearer ${admin.body.accessToken}`)
        .send({ password: 'Missing user password 🔑' }),
      request(app.getHttpServer())
        .post('/api/admin/users/not-a-uuid/reset-password')
        .set('Authorization', `Bearer ${admin.body.accessToken}`)
        .send({ password: 'Missing user password 🔑' }),
    ]);
    expect(notFoundResponses.every((response) => response.status === 404)).toBe(true);
    expect(notFoundResponses.every((response) => response.body.code === 'RESOURCE_NOT_FOUND')).toBe(
      true,
    );
  });

  it('keeps disabled users disabled after a password reset and records safe audit actions', async () => {
    const admin = await login();
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ username: 'disabled-reset-target', password: 'Old disabled password 🔑' });
    const userId = created.body.id as string;
    await request(app.getHttpServer())
      .patch(`/api/admin/users/${userId}/disable`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`);
    const reset = await request(app.getHttpServer())
      .post(`/api/admin/users/${userId}/reset-password`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ password: 'New disabled password 🔑' });
    expect(reset.status).toBe(200);
    expect(reset.body.status).toBe('DISABLED');
    expect(JSON.stringify(reset.body)).not.toMatch(/passwordHash|tokenVersion|password|token/i);

    const logs = await prisma.auditLog.findMany({
      where: {
        resourceId: userId,
        action: { in: ['USER_CREATED', 'USER_DISABLED', 'USER_PASSWORD_RESET'] },
      },
    });
    expect(logs.map((log) => log.action)).toEqual(
      expect.arrayContaining(['USER_CREATED', 'USER_DISABLED', 'USER_PASSWORD_RESET']),
    );
    expect(JSON.stringify(logs)).not.toMatch(
      /Old disabled password|New disabled password|passwordHash|tokenVersion/i,
    );
  });

  it('disables users and resets passwords atomically with session revocation', async () => {
    const admin = await login();
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ username: 'managed-user', password: 'Managed password 🔑' });
    const userId = created.body.id as string;
    const userLogin = await login('managed-user', 'Managed password 🔑');
    const userCookies = userLogin.headers['set-cookie'] as unknown as string[];
    const userCsrf = cookieValue(userCookies, 'buildplatform_csrf');
    const disabled = await request(app.getHttpServer())
      .patch(`/api/admin/users/${userId}/disable`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`);
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('DISABLED');
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/auth/me')
          .set('Authorization', `Bearer ${userLogin.body.accessToken}`)
      ).body.code,
    ).toBe('AUTH_TOKEN_EXPIRED');
    expect((await login('managed-user', 'Managed password 🔑')).body.code).toBe(
      'AUTH_ACCOUNT_DISABLED',
    );
    const disabledRefresh = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(userCookies))
      .set('X-CSRF-Token', userCsrf);
    expect(disabledRefresh.status).toBe(401);
    expect(disabledRefresh.body.code).toBe('AUTH_TOKEN_EXPIRED');
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0);

    const second = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ username: 'reset-user', password: 'Old reset password 🔑' });
    const secondId = second.body.id as string;
    const secondLogin = await login('reset-user', 'Old reset password 🔑');
    const reset = await request(app.getHttpServer())
      .post(`/api/admin/users/${secondId}/reset-password`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`)
      .send({ password: 'New reset password 🔑' });
    expect(reset.status).toBe(200);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/auth/me')
          .set('Authorization', `Bearer ${secondLogin.body.accessToken}`)
      ).body.code,
    ).toBe('AUTH_TOKEN_EXPIRED');
    expect((await login('reset-user', 'Old reset password 🔑')).body.code).toBe(
      'AUTH_INVALID_CREDENTIALS',
    );
    expect((await login('reset-user', 'New reset password 🔑')).status).toBe(200);
    expect(await prisma.refreshToken.count({ where: { userId: secondId, revokedAt: null } })).toBe(
      1,
    );
  });

  it('applies a generic IP/username login limit without account enumeration', async () => {
    const responses = [];
    for (let index = 0; index < 6; index += 1)
      responses.push(await login(`missing-${index}`, 'wrong password 🔑'));
    expect(responses.slice(0, 5).every((response) => response.status === 401)).toBe(true);
    expect(responses[5].status).toBe(429);
    expect(responses[5].body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(responses[5].body.message).toContain('频繁');
  });

  it('protects the last available administrator and serializes first-admin initialization', async () => {
    const admin = await login();
    const last = await request(app.getHttpServer())
      .patch(`/api/admin/users/${adminId}/disable`)
      .set('Authorization', `Bearer ${admin.body.accessToken}`);
    expect(last.status).toBe(400);
    expect(last.body.code).toBe('VALIDATION_FAILED');

    await resetDatabase();
    const isolated = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const results = await Promise.allSettled([
      initializeFirstAdmin(isolated, {
        username: 'first-admin-a',
        password: 'First admin password 🔑',
      }),
      initializeFirstAdmin(isolated, {
        username: 'first-admin-b',
        password: 'First admin password 🔑',
      }),
    ]);
    await isolated.$disconnect();
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
    const stored = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored.passwordHash).not.toContain('First admin password');
    expect(await prisma.auditLog.count({ where: { action: 'ADMIN_INITIALIZED' } })).toBe(1);
  });
});
