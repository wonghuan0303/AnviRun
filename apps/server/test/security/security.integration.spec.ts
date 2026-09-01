import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import WebSocket from 'ws';

import { AppModule } from '../../src/app.module';
import { configureRequestBodyLimits } from '../../src/common/request-body';
import {
  MAX_AGENT_WS_MESSAGE_BYTES,
  MAX_CLIENT_WS_MESSAGE_BYTES,
  MAX_JSON_BODY_BYTES,
} from '../../src/common/security-limits';
import { PasswordService } from '../../src/auth/password.service';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PrismaService } from '../../src/database/prisma.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Security integration tests require buildplatform_test');
}

jest.setTimeout(30_000);

describe('T6.2 security PostgreSQL/API/WebSocket integration', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let port: number;
  let adminToken: string;
  const password = 'Security admin password 🔐';

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

  async function login(username = 'security-admin', secret = password): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username, password: secret });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureRequestBodyLimits(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    await prisma.user.create({
      data: {
        username: 'security-admin',
        passwordHash: await passwords.hash(password),
        role: UserRole.ADMIN,
      },
    });
    app.get(LoginRateLimiterService).reset();
    adminToken = await login();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a structured response for an oversized JSON body', async () => {
    const body = JSON.stringify({
      username: 'security-admin',
      password,
      padding: 'x'.repeat(MAX_JSON_BODY_BYTES),
    });
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(response.body)).not.toContain('padding');
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });

  it('closes an Agent connection when one message exceeds the WebSocket limit', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/admin/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'security-agent' });
    expect(created.status).toBe(201);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: `Bearer ${created.body.registrationToken as string}` },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 3_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', reject);
    });

    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code: number) => resolve(code));
    });
    socket.send(Buffer.alloc(MAX_AGENT_WS_MESSAGE_BYTES + 1, 0x61));
    const closeCode = await Promise.race([
      closed,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('close timeout')), 3_000),
      ),
    ]);
    expect(closeCode).toBe(1009);
  });

  it('closes a browser log connection when one message exceeds its limit', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/client`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 3_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', reject);
    });

    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code: number) => resolve(code));
    });
    socket.send(Buffer.alloc(MAX_CLIENT_WS_MESSAGE_BYTES + 1, 0x61));
    const closeCode = await Promise.race([
      closed,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('close timeout')), 3_000),
      ),
    ]);
    expect(closeCode).toBe(1009);
  });

  it('records successful and failed login audits with safe result metadata', async () => {
    await login();
    const failed = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'security-admin', password: 'wrong password with enough length' });
    expect(failed.status).toBe(401);

    const logs = await prisma.auditLog.findMany({
      where: { action: { in: ['AUTH_LOGIN_SUCCEEDED', 'AUTH_LOGIN_FAILED'] } },
      select: { action: true, metadata: true },
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'AUTH_LOGIN_SUCCEEDED',
          metadata: expect.objectContaining({ result: 'SUCCESS' }),
        }),
        expect.objectContaining({
          action: 'AUTH_LOGIN_FAILED',
          metadata: expect.objectContaining({ result: 'FAILURE' }),
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(password);
    expect(JSON.stringify(logs)).not.toContain('wrong password with enough length');
  });
});
