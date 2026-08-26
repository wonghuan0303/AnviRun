import { randomUUID } from 'node:crypto';

import { AgentStatus, UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthorizationService } from '../../src/authorization/authorization.service';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PasswordService } from '../../src/auth/password.service';
import { PrismaService } from '../../src/database/prisma.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Project integration tests require buildplatform_test');
}

jest.setTimeout(30_000);

describe('T3.3 project PostgreSQL/API integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authorization: AuthorizationService;
  let adminId: string;
  let userAId: string;
  let userBId: string;
  let agentId: string;
  let templateId: string;
  let disabledTemplateId: string;
  let adminToken: string;
  let userAToken: string;
  let userBToken: string;
  let userAPassword: string;
  let userBPassword: string;

  const schema = [
    {
      type: 'input',
      name: 'channel',
      label: 'Channel',
      required: true,
      minLength: 2,
      maxLength: 32,
    },
    { type: 'number', name: 'retries', label: 'Retries', min: 0, max: 5, step: 1, defaultValue: 1 },
    {
      type: 'select',
      name: 'mode',
      label: 'Mode',
      options: [
        { label: 'Stable', value: 'stable' },
        { label: 'Beta', value: 'beta' },
      ],
      defaultValue: 'stable',
    },
    {
      type: 'checkbox',
      name: 'targets',
      label: 'Targets',
      options: [
        { label: 'Web', value: 'web' },
        { label: 'Native', value: 'native' },
      ],
    },
    { type: 'switch', name: 'dryRun', label: 'Dry run', defaultValue: false },
    { type: 'date', name: 'releaseDate', label: 'Release date' },
  ] as const;

  const validConfig = {
    channel: 'release',
    retries: 2,
    mode: 'stable',
    targets: ['web'],
    dryRun: false,
    releaseDate: '2026-08-26',
  };

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

  async function createProject(token: string, overrides: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Release Project',
        description: 'Project description',
        buildTemplateId: templateId,
        branch: 'release/main',
        config: validConfig,
        ...overrides,
      });
  }

  async function getProject(token: string, projectId: string): Promise<Response> {
    return request(app.getHttpServer())
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function expectSafeNotFound(response: Response): void {
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenVersion');
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('storagePath');
    expect(serialized).not.toContain('Prisma');
    expect(serialized).not.toContain('PostgreSQL');
    expect(serialized).not.toContain('stack');
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    authorization = app.get(AuthorizationService);
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    const adminPassword = 'Project admin password 🔐';
    userAPassword = 'Project user A password 🔐';
    userBPassword = 'Project user B password 🔐';

    const [admin, userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          username: 'project-admin',
          passwordHash: await passwords.hash(adminPassword),
          role: UserRole.ADMIN,
        },
      }),
      prisma.user.create({
        data: { username: 'project-owner-a', passwordHash: await passwords.hash(userAPassword) },
      }),
      prisma.user.create({
        data: { username: 'project-owner-b', passwordHash: await passwords.hash(userBPassword) },
      }),
    ]);
    const agent = await prisma.agent.create({
      data: { name: 'project-offline-agent', status: AgentStatus.OFFLINE, enabled: true },
    });
    const template = await prisma.buildTemplate.create({
      data: {
        name: 'project-template',
        agentId: agent.id,
        gitUrl: 'https://example.invalid/project.git',
        command: 'echo project',
        artifactDir: 'dist',
        formSchema: schema,
        createdBy: admin.id,
      },
    });
    const disabledTemplate = await prisma.buildTemplate.create({
      data: {
        name: 'project-disabled-template',
        agentId: agent.id,
        gitUrl: 'https://example.invalid/project-disabled.git',
        command: 'echo disabled',
        artifactDir: 'dist',
        formSchema: [],
        enabled: false,
        createdBy: admin.id,
      },
    });

    adminId = admin.id;
    userAId = userA.id;
    userBId = userB.id;
    agentId = agent.id;
    templateId = template.id;
    disabledTemplateId = disabledTemplate.id;
    app.get(LoginRateLimiterService).reset();
    adminToken = await login('project-admin', adminPassword);
    userAToken = await login('project-owner-a', userAPassword);
    userBToken = await login('project-owner-b', userBPassword);
  });

  afterAll(async () => {
    await app.close();
  });

  it('assigns ownership on the server and rejects ownerId/deletedAt tampering', async () => {
    const tampered = await createProject(userAToken, { ownerId: userBId });
    expect(tampered.status).toBe(400);
    expect(tampered.body.code).toBe('VALIDATION_FAILED');

    const created = await createProject(userAToken);
    expect(created.status).toBe(201);
    expect(created.body.project.ownerId).toBe(userAId);
    expect(created.body.project.owner.id).toBe(userAId);
    expect(
      await prisma.project.findUnique({
        where: { id: created.body.project.id },
        select: { ownerId: true, deletedAt: true },
      }),
    ).toEqual({ ownerId: userAId, deletedAt: null });

    const adminTampered = await createProject(adminToken, { ownerId: userBId });
    expect(adminTampered.status).toBe(400);
    const adminOwned = await createProject(adminToken, { name: 'Admin Project' });
    expect(adminOwned.status).toBe(201);
    expect(adminOwned.body.project.ownerId).toBe(adminId);
  });

  it('requires an enabled template but accepts an enabled OFFLINE agent', async () => {
    expect((await createProject(userAToken)).status).toBe(201);
    const disabled = await createProject(userAToken, {
      name: 'Disabled Template Project',
      buildTemplateId: disabledTemplateId,
    });
    expect(disabled.status).toBe(400);
    expect(disabled.body.code).toBe('BUILD_TEMPLATE_INVALID');
  });

  it('validates project fields and config values without leaking database details', async () => {
    for (const overrides of [
      { name: '   ' },
      { name: 'x'.repeat(129) },
      { name: 'bad\nname' },
      { branch: '   ' },
      { branch: 'bad\nbranch' },
      { branch: 'x'.repeat(513) },
      { buildTemplateId: 'not-a-uuid' },
      { config: [] },
      { config: { channel: null } },
      { config: { channel: 123 } },
      { config: { channel: 'a' } },
      { config: { retries: 9 } },
      { config: { mode: 'unknown' } },
      { config: { targets: ['web', 'web'] } },
      { config: { dryRun: 'false' } },
      { config: { releaseDate: '2026-02-30' } },
      { config: { nested: { value: true } } },
    ]) {
      const response = await createProject(userAToken, overrides);
      expect(response.status).toBe(400);
      expect(['VALIDATION_FAILED', 'PROJECT_CONFIG_INVALID']).toContain(response.body.code);
      expect(JSON.stringify(response.body)).not.toContain('Prisma');
      expect(JSON.stringify(response.body)).not.toContain('stack');
    }
  });

  it('filters unknown fields, applies defaults, and persists one normalized config', async () => {
    const response = await createProject(userAToken, {
      config: { channel: 'release', targets: [], unknown: 'must be removed' },
    });
    expect(response.status).toBe(201);
    expect(response.body.project.config).toEqual({
      channel: 'release',
      retries: 1,
      mode: 'stable',
      targets: [],
      dryRun: false,
    });
    const stored = await prisma.project.findUnique({
      where: { id: response.body.project.id },
      select: { config: true },
    });
    expect(stored?.config).toEqual(response.body.project.config);
    expect(JSON.stringify(response.body)).not.toContain('unknown');
  });

  it('supports an empty schema and generic missing-template responses', async () => {
    const empty = await prisma.buildTemplate.create({
      data: {
        name: 'empty-project-template',
        agentId,
        gitUrl: 'https://example.invalid/empty.git',
        command: 'echo empty',
        artifactDir: 'dist',
        formSchema: [],
        createdBy: adminId,
      },
    });
    const response = await createProject(userAToken, {
      name: 'Empty Schema Project',
      buildTemplateId: empty.id,
      config: { arbitrary: 'removed' },
    });
    expect(response.status).toBe(201);
    expect(response.body.project.config).toEqual({});
    expect(response.body.project.configCompatibility.effectiveConfig).toEqual({});

    const missing = await createProject(userAToken, { buildTemplateId: randomUUID() });
    expectSafeNotFound(missing);
  });

  it('lists projects with owner scope, search, pagination, and admin owner filtering', async () => {
    expect((await createProject(userAToken, { name: 'A Alpha' })).status).toBe(201);
    expect((await createProject(userAToken, { name: 'A Beta' })).status).toBe(201);
    expect((await createProject(userBToken, { name: 'B Alpha' })).status).toBe(201);

    const userAWithBFilter = await request(app.getHttpServer())
      .get(`/api/projects?ownerId=${userBId}&pageSize=100`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(userAWithBFilter.status).toBe(200);
    expect(userAWithBFilter.body.items).toHaveLength(0);

    const userBList = await request(app.getHttpServer())
      .get('/api/projects?pageSize=100')
      .set('Authorization', `Bearer ${userBToken}`);
    expect(userBList.body.items).toHaveLength(1);
    expect(userBList.body.items[0].ownerId).toBe(userBId);

    const adminList = await request(app.getHttpServer())
      .get(`/api/projects?ownerId=${userAId}&pageSize=100`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.body.items).toHaveLength(2);
    expect(
      adminList.body.items.every((item: { ownerId: string }) => item.ownerId === userAId),
    ).toBe(true);

    const searched = await request(app.getHttpServer())
      .get('/api/projects?search=Beta&pageSize=100')
      .set('Authorization', `Bearer ${userAToken}`);
    expect(searched.body.items.map((item: { name: string }) => item.name)).toEqual(['A Beta']);

    const paged = await request(app.getHttpServer())
      .get('/api/projects?page=2&pageSize=1')
      .set('Authorization', `Bearer ${userAToken}`);
    expect(paged.body.total).toBe(2);
    expect(paged.body.items[0].name).toBe('A Beta');

    const all = await request(app.getHttpServer())
      .get('/api/projects?pageSize=100')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(all.body.total).toBe(3);
  });

  it('returns the same safe 404 for cross-user, deleted, missing, and invalid project IDs', async () => {
    const own = await createProject(userAToken, { name: 'A Private' });
    const other = await createProject(userBToken, { name: 'B Private' });
    const cross = await getProject(userAToken, other.body.project.id);
    const missing = await getProject(userAToken, randomUUID());
    const invalid = await getProject(userAToken, 'not-a-uuid');
    expectSafeNotFound(cross);
    expectSafeNotFound(missing);
    expectSafeNotFound(invalid);
    expect([cross.status, cross.body.code, cross.body.message]).toEqual([
      missing.status,
      missing.body.code,
      missing.body.message,
    ]);

    const deleted = await request(app.getHttpServer())
      .delete(`/api/projects/${own.body.project.id}`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(deleted.status).toBe(204);
    expectSafeNotFound(await getProject(userAToken, own.body.project.id));
    expectSafeNotFound(
      await request(app.getHttpServer())
        .delete(`/api/projects/${own.body.project.id}`)
        .set('Authorization', `Bearer ${userAToken}`),
    );
  });

  it('allows ADMIN to modify active projects and rejects protected PATCH fields', async () => {
    const created = await createProject(userAToken, { name: 'Original' });
    const projectId = created.body.project.id as string;
    for (const body of [
      { ownerId: userBId },
      { buildTemplateId: randomUUID() },
      { config: {} },
      { deletedAt: new Date().toISOString() },
    ]) {
      const response = await request(app.getHttpServer())
        .patch(`/api/projects/${projectId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }

    const updated = await request(app.getHttpServer())
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Admin Updated', description: null, branch: 'hotfix/v2' });
    expect(updated.status).toBe(200);
    expect(updated.body.project).toEqual(
      expect.objectContaining({
        ownerId: userAId,
        name: 'Admin Updated',
        description: null,
        branch: 'hotfix/v2',
      }),
    );
  });

  it('updates the one Project.config through the dedicated endpoint', async () => {
    const created = await createProject(userAToken, { config: { channel: 'release' } });
    const projectId = created.body.project.id as string;
    expect(
      (
        await request(app.getHttpServer())
          .put(`/api/projects/${projectId}/config`)
          .set('Authorization', `Bearer ${userAToken}`)
          .send({ config: { channel: null } })
      ).body.code,
    ).toBe('PROJECT_CONFIG_INVALID');

    const saved = await request(app.getHttpServer())
      .put(`/api/projects/${projectId}/config`)
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ config: { channel: 'hotfix', mode: 'beta', retries: 0 } });
    expect(saved.status).toBe(200);
    expect(saved.body.project.config).toEqual({
      channel: 'hotfix',
      retries: 0,
      mode: 'beta',
      dryRun: false,
    });
    expect(await prisma.project.count({ where: { id: projectId } })).toBe(1);
    expect(
      (
        await prisma.project.findUnique({
          where: { id: projectId },
          select: { config: true },
        })
      )?.config,
    ).toEqual(saved.body.project.config);
  });

  it('reports template compatibility changes and build readiness', async () => {
    const created = await createProject(userAToken);
    const projectId = created.body.project.id as string;

    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: {
        formSchema: [
          ...schema,
          { type: 'input', name: 'newDefault', label: 'New', defaultValue: 'default' },
        ],
      },
    });
    let response = await getProject(userAToken, projectId);
    expect(response.body.project.configCompatibility).toMatchObject({
      valid: true,
      effectiveConfig: expect.objectContaining({ newDefault: 'default' }),
      buildable: true,
    });

    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: {
        formSchema: [
          ...schema,
          { type: 'input', name: 'newRequired', label: 'Required', required: true },
        ],
      },
    });
    response = await getProject(userAToken, projectId);
    expect(response.body.project.configCompatibility).toMatchObject({
      valid: false,
      missingFields: ['newRequired'],
      buildable: false,
    });

    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: { formSchema: [{ ...schema[0] }] },
    });
    response = await getProject(userAToken, projectId);
    expect(response.body.project.configCompatibility).toMatchObject({
      valid: true,
      effectiveConfig: { channel: 'release' },
      obsoleteFields: expect.arrayContaining(['retries', 'mode', 'targets', 'dryRun']),
    });

    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: { formSchema: [{ type: 'number', name: 'channel', label: 'Channel' }] },
    });
    response = await getProject(userAToken, projectId);
    expect(response.body.project.configCompatibility.typeConflictFields).toEqual(['channel']);

    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: {
        formSchema: [
          {
            type: 'select',
            name: 'channel',
            label: 'Channel',
            options: [{ label: 'Other', value: 'other' }],
          },
        ],
      },
    });
    response = await getProject(userAToken, projectId);
    expect(response.body.project.configCompatibility.valid).toBe(false);

    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: { enabled: false },
    });
    response = await getProject(userAToken, projectId);
    expect(response.status).toBe(200);
    expect(response.body.project.configCompatibility).toMatchObject({
      templateEnabled: false,
      buildable: false,
    });

    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: { enabled: true, formSchema: schema },
    });
    await prisma.agent.update({
      where: { id: agentId },
      data: { enabled: false, status: AgentStatus.DISABLED },
    });
    response = await getProject(userAToken, projectId);
    expect(response.body.project.configCompatibility).toMatchObject({
      agentEnabled: false,
      buildable: false,
    });

    await prisma.agent.update({
      where: { id: agentId },
      data: { enabled: true, status: AgentStatus.OFFLINE },
    });
    const repaired = await request(app.getHttpServer())
      .put(`/api/projects/${projectId}/config`)
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ config: validConfig });
    expect(repaired.body.project.configCompatibility.buildable).toBe(true);
  });

  it('keeps inherited task and artifact access excluded after project soft deletion', async () => {
    const created = await createProject(userAToken);
    const task = await prisma.buildTask.create({
      data: {
        projectId: created.body.project.id,
        buildTemplateId: templateId,
        agentId,
        createdBy: userBId,
        branch: 'main',
        config: {},
      },
    });
    const artifact = await prisma.artifact.create({
      data: {
        taskId: task.id,
        relativePath: 'dist/out.zip',
        fileName: 'out.zip',
        size: 1,
        sha256: 'a'.repeat(64),
        storagePath: 'C:\\private\\owner-a\\out.zip',
      },
    });
    await request(app.getHttpServer())
      .delete(`/api/projects/${created.body.project.id}`)
      .set('Authorization', `Bearer ${userAToken}`);

    const actor = {
      id: userAId,
      username: 'project-owner-a',
      role: UserRole.USER,
      status: 'ACTIVE' as const,
      tokenVersion: 0,
      jti: randomUUID(),
    };
    expect(
      await prisma.buildTask.findFirst({
        where: authorization.taskScope(actor, { id: task.id }),
        select: { id: true },
      }),
    ).toBeNull();
    expect(
      await prisma.artifact.findFirst({
        where: authorization.artifactScope(actor, { id: artifact.id }),
        select: { id: true },
      }),
    ).toBeNull();
  });

  it('keeps authentication and response boundaries unchanged', async () => {
    const unauthenticated = await request(app.getHttpServer()).get('/api/projects');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.code).toBe('AUTH_TOKEN_EXPIRED');

    const created = await createProject(userAToken);
    expect(created.status).toBe(201);
    const serialized = JSON.stringify(created.body);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenVersion');
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('storagePath');
    expect(serialized).not.toContain('stack');
  });
});
