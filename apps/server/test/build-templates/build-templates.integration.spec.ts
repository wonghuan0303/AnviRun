import { randomUUID } from 'node:crypto';

import { AgentStatus, UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { PasswordService } from '../../src/auth/password.service';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PrismaService } from '../../src/database/prisma.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Build template integration tests require buildplatform_test');
}

jest.setTimeout(30_000);

describe('T3.1 build template PostgreSQL/API integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminId: string;
  let userId: string;
  let offlineAgentId: string;
  let disabledAgentId: string;
  let adminToken: string;
  let userToken: string;

  const adminPassword = 'Build template admin password 🔐';
  const userPassword = 'Build template user password 🔐';

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

  async function login(username: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username, password });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  function templateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'Desktop Release',
      description: 'Builds the desktop release package',
      agentId: offlineAgentId,
      gitUrl: 'https://github.com/example/build-platform.git',
      command: 'pnpm build --mode release | tee build.log',
      artifactDir: 'dist',
      formSchema: [],
      ...overrides,
    };
  }

  async function createTemplate(overrides: Record<string, unknown> = {}, token = adminToken) {
    return request(app.getHttpServer())
      .post('/api/admin/build-templates')
      .set('Authorization', `Bearer ${token}`)
      .send(templateInput(overrides));
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    const [admin, user] = await Promise.all([
      prisma.user.create({
        data: {
          username: 'template-admin',
          passwordHash: await passwords.hash(adminPassword),
          role: UserRole.ADMIN,
        },
      }),
      prisma.user.create({
        data: {
          username: 'template-user',
          passwordHash: await passwords.hash(userPassword),
        },
      }),
    ]);
    const offlineAgent = await prisma.agent.create({
      data: {
        name: 'template-offline-agent',
        status: AgentStatus.OFFLINE,
        enabled: true,
        tokenHash: `offline-token-${randomUUID()}`,
      },
    });
    const disabledAgent = await prisma.agent.create({
      data: {
        name: 'template-disabled-agent',
        status: AgentStatus.DISABLED,
        enabled: false,
        tokenHash: `disabled-token-${randomUUID()}`,
      },
    });
    adminId = admin.id;
    userId = user.id;
    offlineAgentId = offlineAgent.id;
    disabledAgentId = disabledAgent.id;
    app.get(LoginRateLimiterService).reset();
    adminToken = await login('template-admin', adminPassword);
    userToken = await login('template-user', userPassword);
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows ADMIN to create and immediately read a complete template', async () => {
    const created = await createTemplate();
    expect(created.status).toBe(201);
    expect(created.body.template).toEqual(
      expect.objectContaining({
        name: 'Desktop Release',
        createdBy: adminId,
        timeoutSeconds: 3600,
        formSchema: [],
        artifactDir: 'dist',
        agent: expect.objectContaining({
          id: offlineAgentId,
          enabled: true,
          status: 'OFFLINE',
        }),
      }),
    );
    expect(JSON.stringify(created.body)).not.toContain('tokenHash');

    const read = await request(app.getHttpServer())
      .get(`/api/admin/build-templates/${created.body.template.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(read.status).toBe(200);
    expect(read.body.template).toEqual(created.body.template);
  });

  it('handles optional nullable descriptions for create and update', async () => {
    const body = templateInput();
    delete body.description;
    const omitted = await request(app.getHttpServer())
      .post('/api/admin/build-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
    expect(omitted.status).toBe(201);
    expect(omitted.body.template.description).toBeNull();

    const stored = await prisma.buildTemplate.findUnique({
      where: { id: omitted.body.template.id },
      select: { description: true },
    });
    expect(stored?.description).toBeNull();

    const withDescription = await createTemplate({
      name: 'Descriptionful Template',
      description: 'Original description',
    });
    const preserved = await request(app.getHttpServer())
      .patch(`/api/admin/build-templates/${withDescription.body.template.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Descriptionful Template Updated' });
    expect(preserved.status).toBe(200);
    expect(preserved.body.template.description).toBe('Original description');

    const clearedByNull = await request(app.getHttpServer())
      .patch(`/api/admin/build-templates/${withDescription.body.template.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: null });
    expect(clearedByNull.status).toBe(200);
    expect(clearedByNull.body.template.description).toBeNull();

    const clearedByEmpty = await request(app.getHttpServer())
      .patch(`/api/admin/build-templates/${withDescription.body.template.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: '   ' });
    expect(clearedByEmpty.status).toBe(200);
    expect(clearedByEmpty.body.template.description).toBeNull();
  });
  it('updates current content without allowing createdBy tampering', async () => {
    const created = await createTemplate();
    const updated = await request(app.getHttpServer())
      .patch(`/api/admin/build-templates/${created.body.template.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Updated Release',
        description: null,
        agentId: offlineAgentId,
        gitUrl: 'ssh://git@github.com/example/build-platform.git',
        command: 'cargo build --release',
        artifactDir: 'target\\release',
        formSchema: [{ type: 'input', name: 'version', label: 'Version', defaultValue: '1.0.0' }],
        timeoutSeconds: 120,
      });
    expect(updated.status).toBe(200);
    expect(updated.body.template).toEqual(
      expect.objectContaining({
        name: 'Updated Release',
        description: null,
        command: 'cargo build --release',
        artifactDir: 'target/release',
        timeoutSeconds: 120,
        createdBy: adminId,
      }),
    );

    const tampered = await request(app.getHttpServer())
      .patch(`/api/admin/build-templates/${created.body.template.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Still Safe', createdBy: userId });
    expect(tampered.status).toBe(400);

    const read = await request(app.getHttpServer())
      .get(`/api/admin/build-templates/${created.body.template.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(read.body.template.createdBy).toBe(adminId);
  });

  it('keeps enable and disable operations idempotent', async () => {
    const created = await createTemplate();
    const firstDisable = await request(app.getHttpServer())
      .post(`/api/admin/build-templates/${created.body.template.id}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const secondDisable = await request(app.getHttpServer())
      .post(`/api/admin/build-templates/${created.body.template.id}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(firstDisable.status).toBe(200);
    expect(secondDisable.status).toBe(200);
    expect(secondDisable.body.template.enabled).toBe(false);

    const firstEnable = await request(app.getHttpServer())
      .post(`/api/admin/build-templates/${created.body.template.id}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const secondEnable = await request(app.getHttpServer())
      .post(`/api/admin/build-templates/${created.body.template.id}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(firstEnable.status).toBe(200);
    expect(secondEnable.status).toBe(200);
    expect(secondEnable.body.template.enabled).toBe(true);
  });

  it('restricts template mutations to ADMIN', async () => {
    const created = await createTemplate();
    const url = `/api/admin/build-templates/${created.body.template.id}`;
    const responses = await Promise.all([
      createTemplate({}, userToken),
      request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Nope' }),
      request(app.getHttpServer())
        .post(`${url}/enable`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app.getHttpServer())
        .post(`${url}/disable`)
        .set('Authorization', `Bearer ${userToken}`),
      request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${userToken}`),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  });

  it('lists only enabled templates for USER while ADMIN can list disabled templates', async () => {
    const enabled = await createTemplate({ name: 'Enabled Template' });
    const disabled = await createTemplate({ name: 'Disabled Template' });
    await request(app.getHttpServer())
      .post(`/api/admin/build-templates/${disabled.body.template.id}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);

    const userList = await request(app.getHttpServer())
      .get('/api/build-templates')
      .set('Authorization', `Bearer ${userToken}`);
    expect(userList.status).toBe(200);
    expect(userList.body.items.map((item: { id: string }) => item.id)).toEqual([
      enabled.body.template.id,
    ]);
    expect(JSON.stringify(userList.body)).not.toContain('command');
    expect(JSON.stringify(userList.body)).not.toContain('tokenHash');

    const userDisabled = await request(app.getHttpServer())
      .get(`/api/build-templates/${disabled.body.template.id}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(userDisabled.status).toBe(404);
    expect(userDisabled.body.code).toBe('RESOURCE_NOT_FOUND');

    const adminList = await request(app.getHttpServer())
      .get('/api/admin/build-templates?enabled=false')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.items.map((item: { id: string }) => item.id)).toEqual([
      disabled.body.template.id,
    ]);
  });

  it('rejects invalid IDs and keeps not-found responses generic', async () => {
    const invalidAdmin = await request(app.getHttpServer())
      .get('/api/admin/build-templates/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`);
    const invalidPublic = await request(app.getHttpServer())
      .get('/api/build-templates/not-a-uuid')
      .set('Authorization', `Bearer ${userToken}`);
    const missing = await request(app.getHttpServer())
      .get(`/api/admin/build-templates/${randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(
      [invalidAdmin, invalidPublic, missing].map((response) => [
        response.status,
        response.body.code,
      ]),
    ).toEqual([
      [404, 'RESOURCE_NOT_FOUND'],
      [404, 'RESOURCE_NOT_FOUND'],
      [404, 'RESOURCE_NOT_FOUND'],
    ]);
    expect(JSON.stringify(missing.body)).not.toContain('Prisma');
    expect(JSON.stringify(missing.body)).not.toContain('stack');
  });

  it('requires an existing enabled Agent and accepts an enabled OFFLINE Agent', async () => {
    const offline = await createTemplate({ name: 'Offline Agent Template' });
    expect(offline.status).toBe(201);

    const missing = await createTemplate({ agentId: randomUUID() });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RESOURCE_NOT_FOUND');

    const disabled = await createTemplate({ agentId: disabledAgentId });
    expect(disabled.status).toBe(409);
    expect(disabled.body.code).toBe('AGENT_DISABLED');
  });

  it('validates Git URL, command, and canonical relative artifact paths', async () => {
    for (const overrides of [
      { gitUrl: 'ftp://github.com/example/repo.git' },
      { gitUrl: 'https://user:password@example.com/repo.git' },
      { command: '   ' },
      { artifactDir: '/var/builds' },
      { artifactDir: 'C:\\builds' },
      { artifactDir: '\\\\server\\share' },
      { artifactDir: '../outside' },
      { artifactDir: 'dist/../../outside' },
    ]) {
      const response = await createTemplate(overrides);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }

    const valid = await createTemplate({ artifactDir: 'target\\release\\.' });
    expect(valid.status).toBe(201);
    expect(valid.body.template.artifactDir).toBe('target/release');
  });

  it('uses the shared form-schema validator and preserves issue locations', async () => {
    const invalidSchemas = [
      [
        { type: 'input', name: 'version', label: 'Version' },
        { type: 'input', name: 'version', label: 'Duplicate' },
      ],
      [{ type: 'calendar', name: 'date', label: 'Date' }],
      [
        {
          type: 'select',
          name: 'channel',
          label: 'Channel',
          options: [{ label: 'Stable', value: 'stable' }],
          defaultValue: 'beta',
        },
      ],
    ];

    for (const formSchema of invalidSchemas) {
      const response = await createTemplate({ formSchema });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details.issues.length).toBeGreaterThan(0);
      expect(response.body.details.issues[0]).toEqual(
        expect.objectContaining({ code: expect.any(String), pointer: expect.any(String) }),
      );
    }
  });

  it('rejects duplicate names within one Agent but allows the same name on another Agent', async () => {
    const first = await createTemplate({ name: 'Same Name' });
    expect(first.status).toBe(201);
    const duplicate = await createTemplate({ name: 'Same Name' });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe('BUILD_TEMPLATE_INVALID');

    const otherAgent = await prisma.agent.create({
      data: {
        name: 'template-second-agent',
        status: AgentStatus.OFFLINE,
        enabled: true,
        tokenHash: `second-token-${randomUUID()}`,
      },
    });
    const allowed = await createTemplate({ name: 'Same Name', agentId: otherAgent.id });
    expect(allowed.status).toBe(201);
  });

  it('returns a conflict when deleting a referenced template and 404 for an unknown template', async () => {
    const missing = await request(app.getHttpServer())
      .delete(`/api/admin/build-templates/${randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RESOURCE_NOT_FOUND');

    const created = await createTemplate();
    await prisma.project.create({
      data: {
        ownerId: userId,
        buildTemplateId: created.body.template.id,
        name: 'Referenced Project',
        branch: 'main',
        config: {},
      },
    });
    const deleted = await request(app.getHttpServer())
      .delete(`/api/admin/build-templates/${created.body.template.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe('BUILD_TEMPLATE_INVALID');
    expect(JSON.stringify(deleted.body)).not.toContain('Prisma');
  });

  it('rejects unauthenticated template access', async () => {
    const admin = await request(app.getHttpServer()).get('/api/admin/build-templates');
    const user = await request(app.getHttpServer()).get('/api/build-templates');
    expect(admin.status).toBe(401);
    expect(user.status).toBe(401);
    expect(admin.body.code).toBe('AUTH_TOKEN_EXPIRED');
    expect(user.body.code).toBe('AUTH_TOKEN_EXPIRED');
  });
});
