import { AgentStatus, BuildTaskStatus, UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PasswordService } from '../../src/auth/password.service';
import { PrismaService } from '../../src/database/prisma.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Task integration tests require buildplatform_test');
}

const schema = [
  {
    name: 'channel',
    label: 'Channel',
    type: 'input',
    required: true,
    defaultValue: 'dev',
  },
] as const;

describe('T4.1 task REST PostgreSQL integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminId: string;
  let userAId: string;
  let userBId: string;
  let agentId: string;
  let templateId: string;
  let projectAId: string;
  let projectBId: string;
  let adminToken: string;
  let userAToken: string;
  let userBToken: string;

  async function resetDatabase(): Promise<void> {
    await prisma.agent.updateMany({ data: { activeTaskId: null } });
    await prisma.artifact.deleteMany();
    await prisma.buildTaskStatusHistory.deleteMany();
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

  async function createTask(token: string, projectId = projectAId, body: unknown = {}) {
    return request(app.getHttpServer())
      .post(`/api/projects/${projectId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);
  }

  async function createDirectTask(
    projectId: string,
    status: BuildTaskStatus = BuildTaskStatus.WAITING_AGENT,
  ) {
    return prisma.buildTask.create({
      data: {
        projectId,
        buildTemplateId: templateId,
        agentId,
        createdBy: userAId,
        status,
        statusReason: null,
        branch: 'main',
        config: { channel: 'dev' },
        queuedAt: status === BuildTaskStatus.QUEUED ? new Date() : null,
      },
    });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    const [admin, userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          username: 'task-admin',
          passwordHash: await passwords.hash('Task admin password 🔐'),
          role: UserRole.ADMIN,
        },
      }),
      prisma.user.create({
        data: {
          username: 'task-owner-a',
          passwordHash: await passwords.hash('Task owner A password 🔐'),
        },
      }),
      prisma.user.create({
        data: {
          username: 'task-owner-b',
          passwordHash: await passwords.hash('Task owner B password 🔐'),
        },
      }),
    ]);
    const agent = await prisma.agent.create({
      data: { name: 'task-agent', enabled: true, status: AgentStatus.OFFLINE },
    });
    const template = await prisma.buildTemplate.create({
      data: {
        name: 'task-template',
        description: 'task template',
        agentId: agent.id,
        gitUrl: 'https://example.invalid/task.git',
        command: 'echo build',
        artifactDir: 'dist',
        formSchema: schema,
        createdBy: admin.id,
        timeoutSeconds: 60,
      },
    });
    const [projectA, projectB] = await Promise.all([
      prisma.project.create({
        data: {
          ownerId: userA.id,
          buildTemplateId: template.id,
          name: 'Project A',
          branch: 'main',
          config: {},
        },
      }),
      prisma.project.create({
        data: {
          ownerId: userB.id,
          buildTemplateId: template.id,
          name: 'Project B',
          branch: 'release/v1',
          config: { channel: 'prod' },
        },
      }),
    ]);
    adminId = admin.id;
    userAId = userA.id;
    userBId = userB.id;
    agentId = agent.id;
    templateId = template.id;
    projectAId = projectA.id;
    projectBId = projectB.id;
    app.get(LoginRateLimiterService).reset();
    adminToken = await login('task-admin', 'Task admin password 🔐');
    userAToken = await login('task-owner-a', 'Task owner A password 🔐');
    userBToken = await login('task-owner-b', 'Task owner B password 🔐');
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a task with server-owned creator, project snapshots, and initial history', async () => {
    const response = await createTask(userAToken);
    expect(response.status).toBe(201);
    expect(response.body.task).toEqual(
      expect.objectContaining({
        projectId: projectAId,
        buildTemplateId: templateId,
        agentId,
        createdBy: userAId,
        status: 'WAITING_AGENT',
        branch: 'main',
        config: { channel: 'dev' },
        statusHistory: expect.arrayContaining([
          expect.objectContaining({ fromStatus: null, toStatus: 'CREATED' }),
          expect.objectContaining({ fromStatus: 'CREATED', toStatus: 'WAITING_AGENT' }),
        ]),
      }),
    );
    expect(response.body.task.agent).not.toHaveProperty('activeTaskId');
    expect(response.body.task.buildTemplate.agent).not.toHaveProperty('activeTaskId');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('leaseHash');
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenVersion');
    const stored = await prisma.buildTask.findUniqueOrThrow({
      where: { id: response.body.task.id },
    });
    expect(stored.createdBy).toBe(userAId);
    expect(stored.config).toEqual({ channel: 'dev' });
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: stored.id } })).toBe(2);
  });

  it('rejects internal fields in the request body and never accepts a client owner', async () => {
    const response = await createTask(userAToken, projectAId, {
      ownerId: userBId,
      projectId: projectBId,
      agentId,
      buildTemplateId: templateId,
      status: 'QUEUED',
      config: { channel: 'attacker' },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(await prisma.buildTask.count()).toBe(0);
  });

  it('allows ADMIN to create for another project but keeps createdBy as the administrator', async () => {
    const response = await createTask(adminToken, projectBId);
    expect(response.status).toBe(201);
    expect(response.body.task.createdBy).toBe(adminId);
    expect(response.body.task.projectId).toBe(projectBId);
    expect(response.body.task.branch).toBe('release/v1');
    expect(response.body.task.config).toEqual({ channel: 'prod' });
  });

  it('isolates task list/detail/create by Project.ownerId and hides soft-deleted projects', async () => {
    const own = await createTask(userAToken);
    expect(own.status).toBe(201);
    const other = await createTask(userBToken, projectBId);
    expect(other.status).toBe(201);

    const list = await request(app.getHttpServer())
      .get(`/api/projects/${projectAId}/tasks?ownerId=${userBId}`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(list.status).toBe(400);
    expect(list.body.code).toBe('VALIDATION_FAILED');

    const ownList = await request(app.getHttpServer())
      .get(`/api/projects/${projectAId}/tasks`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(ownList.status).toBe(200);
    expect(ownList.body.items.map((task: { id: string }) => task.id)).toEqual([own.body.task.id]);

    const cross = await request(app.getHttpServer())
      .get(`/api/tasks/${other.body.task.id}`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe('RESOURCE_NOT_FOUND');

    await prisma.project.update({ where: { id: projectAId }, data: { deletedAt: new Date() } });
    const deletedDetail = await request(app.getHttpServer())
      .get(`/api/tasks/${own.body.task.id}`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(deletedDetail.status).toBe(404);
    const deletedCreate = await createTask(userAToken);
    expect(deletedCreate.status).toBe(404);
  });

  it('rejects disabled templates and Agents but accepts an enabled offline Agent', async () => {
    const offline = await createTask(userAToken);
    expect(offline.status).toBe(201);
    expect(offline.body.task.status).toBe('WAITING_AGENT');

    await prisma.buildTemplate.update({ where: { id: templateId }, data: { enabled: false } });
    const disabledTemplate = await createTask(userAToken, projectAId);
    expect(disabledTemplate.status).toBe(400);
    expect(disabledTemplate.body.code).toBe('BUILD_TEMPLATE_INVALID');

    await prisma.buildTemplate.update({ where: { id: templateId }, data: { enabled: true } });
    await prisma.agent.update({
      where: { id: agentId },
      data: { enabled: false, status: AgentStatus.DISABLED },
    });
    const disabledAgent = await createTask(userAToken, projectAId);
    expect(disabledAgent.status).toBe(409);
    expect(disabledAgent.body.code).toBe('AGENT_DISABLED');
  });

  it('keeps task branch/config snapshots independent from later project changes', async () => {
    const created = await createTask(userAToken);
    expect(created.status).toBe(201);
    await prisma.project.update({
      where: { id: projectAId },
      data: { branch: 'feature/changed', config: { channel: 'changed' } },
    });
    const detail = await request(app.getHttpServer())
      .get(`/api/tasks/${created.body.task.id}`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.task.branch).toBe('main');
    expect(detail.body.task.config).toEqual({ channel: 'dev' });
  });

  it('supports status filtering, stable descending pagination, and serializes BIGINT counters', async () => {
    const first = await createDirectTask(projectAId, BuildTaskStatus.WAITING_AGENT);
    const second = await createDirectTask(projectAId, BuildTaskStatus.WAITING_AGENT);
    await prisma.buildTask.update({
      where: { id: first.id },
      data: { logSize: 5_000_000_000n, artifactCount: 2n, artifactBytes: 8_000_000_000n },
    });
    const page = await request(app.getHttpServer())
      .get(`/api/projects/${projectAId}/tasks?page=1&pageSize=1&status=WAITING_AGENT`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(2);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].id).toBe(second.id);
    const detail = await request(app.getHttpServer())
      .get(`/api/tasks/${first.id}`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.task.logSize).toBe('5000000000');
    expect(detail.body.task.artifactCount).toBe('2');
    expect(detail.body.task.artifactBytes).toBe('8000000000');
  });

  it('rejects invalid status and malformed IDs without leaking database details', async () => {
    const invalidStatus = await request(app.getHttpServer())
      .get(`/api/projects/${projectAId}/tasks?status=NOT_A_STATUS`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(invalidStatus.status).toBe(400);
    expect(invalidStatus.body.code).toBe('VALIDATION_FAILED');
    const invalidId = await request(app.getHttpServer())
      .get('/api/tasks/not-a-uuid')
      .set('Authorization', `Bearer ${userAToken}`);
    expect(invalidId.status).toBe(404);
    const serialized = JSON.stringify(invalidId.body);
    expect(serialized).not.toContain('Prisma');
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('passwordHash');
  });

  it('returns ADMIN task list across projects with owner filtering', async () => {
    await createTask(userAToken, projectAId);
    await createTask(userBToken, projectBId);
    const all = await request(app.getHttpServer())
      .get('/api/projects/' + projectAId + '/tasks')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(1);
    const projectBList = await request(app.getHttpServer())
      .get(`/api/projects/${projectBId}/tasks`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(projectBList.status).toBe(200);
    expect(projectBList.body.total).toBe(1);
  });
});
