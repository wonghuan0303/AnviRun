import { randomUUID } from 'node:crypto';

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
  throw new Error('Overview integration tests require buildplatform_test');
}

jest.setTimeout(30_000);

describe('任务概览 PostgreSQL/API integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let templateId: string;
  let agentAId: string;
  let agentBId: string;
  let projectAId: string;
  let projectBId: string;

  async function login(username: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username, password });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  async function resetDatabase(): Promise<void> {
    await prisma.agent.updateMany({ data: { activeTaskId: null } });
    await prisma.artifact.deleteMany();
    await prisma.buildTaskStatusHistory.deleteMany();
    await prisma.buildTask.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.project.deleteMany();
    await prisma.buildTemplate.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.user.deleteMany();
  }

  async function createTask(
    projectId: string,
    agentId: string,
    status: BuildTaskStatus,
    createdAt: Date,
  ): Promise<string> {
    const queuedStatuses: BuildTaskStatus[] = [
      BuildTaskStatus.CREATED,
      BuildTaskStatus.WAITING_AGENT,
      BuildTaskStatus.QUEUED,
    ];
    const runningStatuses: BuildTaskStatus[] = [
      BuildTaskStatus.DISPATCHED,
      BuildTaskStatus.PREPARING,
      BuildTaskStatus.RUNNING,
      BuildTaskStatus.UPLOADING,
      BuildTaskStatus.CANCELING,
      BuildTaskStatus.AGENT_LOST,
    ];
    const task = await prisma.buildTask.create({
      data: {
        projectId,
        buildTemplateId: templateId,
        agentId,
        createdBy: projectId === projectAId ? userAId : userBId,
        status,
        branch: 'main',
        config: {},
        createdAt,
        queuedAt: queuedStatuses.includes(status) ? createdAt : null,
        startedAt: runningStatuses.includes(status) ? createdAt : null,
      },
    });
    return task.id;
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
    const adminPassword = 'Overview admin password 🔐';
    const userAPassword = 'Overview user A password 🔐';
    const userBPassword = 'Overview user B password 🔐';
    const [admin, userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          username: 'overview-admin',
          passwordHash: await passwords.hash(adminPassword),
          role: UserRole.ADMIN,
        },
      }),
      prisma.user.create({
        data: { username: 'overview-user-a', passwordHash: await passwords.hash(userAPassword) },
      }),
      prisma.user.create({
        data: { username: 'overview-user-b', passwordHash: await passwords.hash(userBPassword) },
      }),
    ]);
    const [agentA, agentB, disabledAgent] = await Promise.all([
      prisma.agent.create({ data: { name: 'overview-agent-a', status: AgentStatus.ONLINE } }),
      prisma.agent.create({ data: { name: 'overview-agent-b', status: AgentStatus.OFFLINE } }),
      prisma.agent.create({
        data: { name: 'overview-agent-disabled', status: AgentStatus.DISABLED, enabled: false },
      }),
    ]);
    const template = await prisma.buildTemplate.create({
      data: {
        name: 'overview-template',
        agentId: agentA.id,
        gitUrl: 'https://example.invalid/overview.git',
        command: 'echo overview',
        artifactDir: 'dist',
        formSchema: [],
        createdBy: admin.id,
      },
    });
    const [projectA, projectB, deletedProject] = await Promise.all([
      prisma.project.create({
        data: {
          ownerId: userA.id,
          buildTemplateId: template.id,
          name: 'A 项目',
          branch: 'main',
          config: {},
        },
      }),
      prisma.project.create({
        data: {
          ownerId: userB.id,
          buildTemplateId: template.id,
          name: 'B 项目',
          branch: 'main',
          config: {},
        },
      }),
      prisma.project.create({
        data: {
          ownerId: userA.id,
          buildTemplateId: template.id,
          name: '已删除项目',
          branch: 'main',
          config: {},
          deletedAt: new Date(),
        },
      }),
    ]);

    adminToken = await login('overview-admin', adminPassword);
    userAToken = await login('overview-user-a', userAPassword);
    userBToken = await login('overview-user-b', userBPassword);
    userAId = userA.id;
    userBId = userB.id;
    templateId = template.id;
    agentAId = agentA.id;
    agentBId = agentB.id;
    projectAId = projectA.id;
    projectBId = projectB.id;

    const now = Date.now();
    await createTask(projectA.id, agentA.id, BuildTaskStatus.RUNNING, new Date(now - 5_000));
    await createTask(projectA.id, agentA.id, BuildTaskStatus.QUEUED, new Date(now - 4_000));
    await createTask(projectA.id, agentA.id, BuildTaskStatus.WAITING_AGENT, new Date(now - 3_000));
    await createTask(projectB.id, agentB.id, BuildTaskStatus.PREPARING, new Date(now - 2_000));
    await createTask(projectB.id, agentB.id, BuildTaskStatus.QUEUED, new Date(now - 1_000));
    await createTask(deletedProject.id, disabledAgent.id, BuildTaskStatus.QUEUED, new Date(now));
    await prisma.buildTask.create({
      data: {
        projectId: projectA.id,
        buildTemplateId: template.id,
        agentId: agentA.id,
        createdBy: userA.id,
        status: BuildTaskStatus.SUCCEEDED,
        branch: 'main',
        config: {},
      },
    });
    app.get(LoginRateLimiterService).reset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires authentication and returns the safe aggregate shape', async () => {
    const unauthenticated = await request(app.getHttpServer()).get('/api/overview');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.code).toBe('AUTH_TOKEN_EXPIRED');

    const response = await request(app.getHttpServer())
      .get('/api/overview')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body.generatedAt).toEqual(expect.any(String));
    expect(response.body.metrics).toEqual({
      agentTotal: 3,
      onlineAgentCount: 1,
      runningTaskCount: 2,
      queuedTaskCount: 3,
    });
    expect(response.body.agents).toHaveLength(3);
    expect(
      response.body.agents.find((agent: { id: string }) => agent.id === agentAId).runningTasks,
    ).toHaveLength(1);
    expect(
      response.body.agents.find((agent: { id: string }) => agent.id === agentAId).queuedTasks,
    ).toHaveLength(2);
    expect(
      response.body.agents.find((agent: { id: string }) => agent.id === agentBId).runningTasks,
    ).toHaveLength(1);
    expect(
      response.body.agents.find((agent: { id: string }) => agent.id === agentBId).queuedTasks,
    ).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('已删除项目');
    expect(JSON.stringify(response.body)).not.toContain('SUCCEEDED');
    expect(JSON.stringify(response.body)).not.toContain('command');
    expect(JSON.stringify(response.body)).not.toContain('config');
    expect(JSON.stringify(response.body)).not.toContain('tokenHash');
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain('activeTaskId');
  });

  it('applies database task ownership scope while retaining safe Agent status summaries', async () => {
    const userAResponse = await request(app.getHttpServer())
      .get('/api/overview')
      .set('Authorization', `Bearer ${userAToken}`);
    expect(userAResponse.status).toBe(200);
    expect(userAResponse.body.metrics).toMatchObject({ runningTaskCount: 1, queuedTaskCount: 2 });
    expect(userAResponse.body.agents).toHaveLength(3);
    const userATasks = userAResponse.body.agents.flatMap(
      (agent: { runningTasks: unknown[]; queuedTasks: unknown[] }) => [
        ...agent.runningTasks,
        ...agent.queuedTasks,
      ],
    );
    expect(userATasks).toHaveLength(3);
    expect(userATasks.every((task: { projectId: string }) => task.projectId === projectAId)).toBe(
      true,
    );
    expect(JSON.stringify(userAResponse.body)).not.toContain('B 项目');

    const userBResponse = await request(app.getHttpServer())
      .get('/api/overview')
      .set('Authorization', `Bearer ${userBToken}`);
    expect(userBResponse.body.metrics).toMatchObject({ runningTaskCount: 1, queuedTaskCount: 1 });
    const userBTasks = userBResponse.body.agents.flatMap(
      (agent: { runningTasks: unknown[]; queuedTasks: unknown[] }) => [
        ...agent.runningTasks,
        ...agent.queuedTasks,
      ],
    );
    expect(userBTasks).toHaveLength(2);
    expect(userBTasks.every((task: { projectId: string }) => task.projectId === projectBId)).toBe(
      true,
    );
    expect(JSON.stringify(userBResponse.body)).not.toContain('A 项目');
  });

  it('returns empty task groups without manufacturing task data', async () => {
    await prisma.buildTask.deleteMany();
    await prisma.project.deleteMany();
    await prisma.buildTemplate.deleteMany();
    await prisma.agent.deleteMany();
    const response = await request(app.getHttpServer())
      .get(`/api/overview?ownerId=${randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body.metrics).toEqual({
      agentTotal: 0,
      onlineAgentCount: 0,
      runningTaskCount: 0,
      queuedTaskCount: 0,
    });
    expect(response.body.agents).toEqual([]);
  });
});
