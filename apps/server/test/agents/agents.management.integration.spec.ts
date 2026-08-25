import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import request, { type Response } from 'supertest';

import { AppModule } from '../../src/app.module';
import { AgentTokenService } from '../../src/agents/agent-token.service';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PasswordService } from '../../src/auth/password.service';
import { PrismaService } from '../../src/database/prisma.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Agent integration tests require buildplatform_test');
}

describe('T2.1 Agent management PostgreSQL integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AgentTokenService;
  let adminToken: string;
  let userToken: string;

  async function resetDatabase(): Promise<void> {
    await prisma.agent.updateMany({ data: { activeTaskId: null } });
    await prisma.artifact.deleteMany();
    await prisma.buildTask.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.project.deleteMany();
    await prisma.buildTemplate.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  }

  async function login(username: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username, password });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  async function createAgent(name: string): Promise<{ id: string; token: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/admin/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name });
    expect(response.status).toBe(201);
    return {
      id: response.body.agent.id as string,
      token: response.body.registrationToken as string,
    };
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AgentTokenService);
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    await prisma.user.create({
      data: {
        username: 'agent-admin',
        passwordHash: await passwords.hash('Admin agent password 🔐'),
        role: UserRole.ADMIN,
      },
    });
    await prisma.user.create({
      data: {
        username: 'agent-user',
        passwordHash: await passwords.hash('User agent password 🔐'),
      },
    });
    app.get(LoginRateLimiterService).reset();
    adminToken = await login('agent-admin', 'Admin agent password 🔐');
    userToken = await login('agent-user', 'User agent password 🔐');
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates one-time hashed tokens and never exposes tokenHash in summaries', async () => {
    const created = await createAgent('  Windows Builder  ');
    expect(created.token).toMatch(/^bpa_[A-Za-z0-9_-]{43}$/);
    const stored = await prisma.agent.findUnique({ where: { id: created.id } });
    expect(stored?.name).toBe('Windows Builder');
    expect(stored?.tokenHash).toBe(tokens.hashToken(created.token));
    expect(stored?.tokenHash).not.toBe(created.token);

    const list = await request(app.getHttpServer())
      .get('/api/admin/agents')
      .set('Authorization', `Bearer ${adminToken}`);
    const detail = await request(app.getHttpServer())
      .get(`/api/admin/agents/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(list.body.items[0]).toEqual(
      expect.objectContaining({ name: 'Windows Builder', status: 'OFFLINE' }),
    );
    expect(JSON.stringify({ list: list.body, detail: detail.body })).not.toContain('tokenHash');
    expect(JSON.stringify({ list: list.body, detail: detail.body })).not.toContain(created.token);
  });

  it('protects all management operations from ordinary users', async () => {
    const created = await createAgent('guarded-agent');
    const responses: Response[] = await Promise.all([
      request(app.getHttpServer())
        .get('/api/admin/agents')
        .set('Authorization', `Bearer ${userToken}`),
      request(app.getHttpServer())
        .get(`/api/admin/agents/${created.id}`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app.getHttpServer())
        .patch(`/api/admin/agents/${created.id}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'x' }),
      request(app.getHttpServer())
        .post(`/api/admin/agents/${created.id}/enable`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app.getHttpServer())
        .post(`/api/admin/agents/${created.id}/disable`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app.getHttpServer())
        .post(`/api/admin/agents/${created.id}/token/rotate`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app.getHttpServer())
        .delete(`/api/admin/agents/${created.id}`)
        .set('Authorization', `Bearer ${userToken}`),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
  });

  it('updates names, rejects duplicates, and makes enable/disable idempotent', async () => {
    const first = await createAgent('first-agent');
    const second = await createAgent('second-agent');
    const updated = await request(app.getHttpServer())
      .patch(`/api/admin/agents/${first.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'renamed-agent' });
    expect(updated.status).toBe(200);
    const duplicate = await request(app.getHttpServer())
      .patch(`/api/admin/agents/${second.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'renamed-agent' });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe('VALIDATION_FAILED');
    const forbiddenField = await request(app.getHttpServer())
      .patch(`/api/admin/agents/${first.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'safe-name', enabled: false });
    expect(forbiddenField.status).toBe(400);

    const disabled = await request(app.getHttpServer())
      .post(`/api/admin/agents/${first.id}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const disabledAgain = await request(app.getHttpServer())
      .post(`/api/admin/agents/${first.id}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(disabled.body.agent).toEqual(
      expect.objectContaining({ enabled: false, status: 'DISABLED' }),
    );
    expect(disabledAgain.body.agent).toEqual(
      expect.objectContaining({ enabled: false, status: 'DISABLED' }),
    );
    const enabled = await request(app.getHttpServer())
      .post(`/api/admin/agents/${first.id}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const enabledAgain = await request(app.getHttpServer())
      .post(`/api/admin/agents/${first.id}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(enabled.body.agent).toEqual(
      expect.objectContaining({ enabled: true, status: 'OFFLINE' }),
    );
    expect(enabledAgain.body.agent).toEqual(
      expect.objectContaining({ enabled: true, status: 'OFFLINE' }),
    );
  });

  it('returns safe 404s and blocks deletion while templates or tasks reference an Agent', async () => {
    const created = await createAgent('referenced-agent');
    const invalid = await request(app.getHttpServer())
      .get('/api/admin/agents/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`);
    const unknown = await request(app.getHttpServer())
      .get(`/api/admin/agents/${randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(invalid.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(invalid.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(unknown.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(JSON.stringify(invalid.body)).not.toContain('Prisma');

    const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'agent-admin' } });
    const template = await prisma.buildTemplate.create({
      data: {
        name: 'referenced-template',
        agentId: created.id,
        gitUrl: 'https://example.invalid/agent.git',
        command: 'echo agent',
        artifactDir: 'dist',
        formSchema: [],
        createdBy: admin.id,
      },
    });
    const blocked = await request(app.getHttpServer())
      .delete(`/api/admin/agents/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('VALIDATION_FAILED');
    await prisma.buildTemplate.delete({ where: { id: template.id } });
    const deleted = await request(app.getHttpServer())
      .delete(`/api/admin/agents/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleted.status).toBe(204);
    expect(await prisma.agent.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it('records management actions without tokens or authorization headers in audit metadata', async () => {
    const created = await createAgent('audit-agent');
    const rotated = await request(app.getHttpServer())
      .post(`/api/admin/agents/${created.id}/token/rotate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-request-id', 'agent-audit-test');
    expect(rotated.status).toBe(200);
    const logs = await prisma.auditLog.findMany({ where: { resourceId: created.id } });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(created.token);
    expect(serialized).not.toContain(rotated.body.registrationToken);
    expect(serialized).not.toContain(tokens.hashToken(created.token));
    expect(serialized).not.toContain('Authorization');
    expect(logs.map((log) => log.action)).toEqual(
      expect.arrayContaining(['AGENT_CREATED', 'AGENT_TOKEN_ROTATED']),
    );
  });
});
