import { randomUUID } from 'node:crypto';

import { AgentStatus, BuildTaskStatus, PrismaClient } from '@prisma/client';
import { BUILD_TASK_STATUSES } from '@buildplatform/contracts';

import { claimAgentExecutionSlot } from '../../src/database/execution-slot';
import { listActiveProjectsPage } from '../../src/database/project-query';

const databaseUrl = process.env.DATABASE_URL ?? '';

if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error(
    'Database integration tests require a dedicated DATABASE_URL containing /buildplatform_test',
  );
}

const prisma = new PrismaClient();

interface Fixture {
  userId: string;
  agentId: string;
  templateId: string;
  projectId: string;
}

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

async function createFixture(prefix = 'fixture'): Promise<Fixture> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const user = await prisma.user.create({
    data: {
      username: `${prefix}-user-${suffix}`,
      passwordHash: 'test-placeholder-hash',
    },
  });
  const agent = await prisma.agent.create({
    data: {
      name: `${prefix}-agent-${suffix}`,
      tokenHash: `${prefix}-agent-token-hash-${suffix}`,
      status: AgentStatus.ONLINE,
    },
  });
  const template = await prisma.buildTemplate.create({
    data: {
      name: `${prefix}-template-${suffix}`,
      agentId: agent.id,
      createdBy: user.id,
      gitUrl: 'https://example.invalid/repository.git',
      command: 'echo test',
      artifactDir: 'dist',
      formSchema: [],
    },
  });
  const project = await prisma.project.create({
    data: {
      ownerId: user.id,
      buildTemplateId: template.id,
      name: `${prefix}-project-${suffix}`,
      branch: 'main',
      config: {},
    },
  });

  return {
    userId: user.id,
    agentId: agent.id,
    templateId: template.id,
    projectId: project.id,
  };
}

async function createTask(fixture: Fixture, status: BuildTaskStatus = BuildTaskStatus.QUEUED) {
  return prisma.buildTask.create({
    data: {
      projectId: fixture.projectId,
      buildTemplateId: fixture.templateId,
      agentId: fixture.agentId,
      createdBy: fixture.userId,
      status,
      branch: 'main',
      config: {},
      queuedAt: new Date(),
    },
  });
}

describe('T1.1 PostgreSQL database contracts', () => {
  beforeAll(async () => {
    await prisma.$connect();
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps Prisma BuildTaskStatus exactly aligned with the TypeScript contract', () => {
    expect(Object.values(BuildTaskStatus)).toEqual([...BUILD_TASK_STATUSES]);
  });

  it('enforces canonical lowercase unique usernames', async () => {
    const fixture = await createFixture('username');
    await expect(
      prisma.user.create({
        data: {
          username: (await prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } }))
            .username,
          passwordHash: 'duplicate',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.user.create({
        data: {
          username: 'UPPERCASE-NOT-CANONICAL',
          passwordHash: 'invalid',
        },
      }),
    ).rejects.toThrow(/User_username_lowercase_ck/);
  });

  it('enforces RefreshToken tokenHash uniqueness', async () => {
    const fixture = await createFixture('refresh');
    const tokenHash = 'refresh-token-hash-unique';
    await prisma.refreshToken.create({
      data: {
        userId: fixture.userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await expect(
      prisma.refreshToken.create({
        data: {
          userId: fixture.userId,
          tokenHash,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces Project owner and BuildTemplate foreign keys', async () => {
    const fixture = await createFixture('project-fk');
    await expect(
      prisma.project.create({
        data: {
          ownerId: randomUUID(),
          buildTemplateId: fixture.templateId,
          name: 'invalid-owner',
          branch: 'main',
          config: {},
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.project.create({
        data: {
          ownerId: fixture.userId,
          buildTemplateId: randomUUID(),
          name: 'invalid-template',
          branch: 'main',
          config: {},
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('hides soft-deleted projects from the default active pagination helper', async () => {
    const fixture = await createFixture('project-soft-delete');
    const project = await prisma.project.update({
      where: { id: fixture.projectId },
      data: { deletedAt: new Date() },
    });
    expect(project.deletedAt).not.toBeNull();
    const page = await listActiveProjectsPage(prisma, {
      ownerId: fixture.userId,
      limit: 10,
    });
    expect(page.items).toHaveLength(0);
  });

  it('hides soft-deleted artifacts from the default query', async () => {
    const fixture = await createFixture('artifact-soft-delete');
    const task = await createTask(fixture, BuildTaskStatus.SUCCEEDED);
    const artifact = await prisma.artifact.create({
      data: {
        taskId: task.id,
        relativePath: 'dist/app.zip',
        fileName: 'app.zip',
        size: 12n,
        sha256: 'a'.repeat(64),
        storagePath: 'artifacts/app.zip',
      },
    });
    await prisma.artifact.update({
      where: { id: artifact.id },
      data: { deletedAt: new Date() },
    });
    expect(
      await prisma.artifact.findMany({
        where: { taskId: task.id, deletedAt: null },
      }),
    ).toHaveLength(0);
  });

  it('paginates projects in a stable, gap-free, duplicate-free order', async () => {
    const fixture = await createFixture('project-pagination');
    await prisma.project.createMany({
      data: Array.from({ length: 7 }, (_, index) => ({
        ownerId: fixture.userId,
        buildTemplateId: fixture.templateId,
        name: `page-project-${index}`,
        branch: 'main',
        config: { index },
      })),
    });

    const ids: string[] = [];
    let cursor: { createdAt: Date; id: string } | undefined;
    let page;
    do {
      page = await listActiveProjectsPage(prisma, {
        ownerId: fixture.userId,
        limit: 2,
        cursor,
      });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (page.hasNextPage);

    const expected = await prisma.project.findMany({
      where: { ownerId: fixture.userId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(ids).toEqual(expected.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('allows multiple QUEUED tasks for one Agent', async () => {
    const fixture = await createFixture('queued');
    const tasks = await Promise.all([
      createTask(fixture),
      createTask(fixture),
      createTask(fixture),
    ]);
    expect(tasks.map((task) => task.status)).toEqual([
      BuildTaskStatus.QUEUED,
      BuildTaskStatus.QUEUED,
      BuildTaskStatus.QUEUED,
    ]);
  });

  it('rejects a second execution-slot task for the same Agent at the database level', async () => {
    const fixture = await createFixture('partial-index');
    const first = await createTask(fixture);
    const second = await createTask(fixture);
    await prisma.buildTask.update({
      where: { id: first.id },
      data: { status: BuildTaskStatus.DISPATCHED },
    });
    await expect(
      prisma.buildTask.update({
        where: { id: second.id },
        data: { status: BuildTaskStatus.RUNNING },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows different Agents to occupy execution slots concurrently', async () => {
    const first = await createFixture('parallel-a');
    const second = await createFixture('parallel-b');
    const firstTask = await createTask(first);
    const secondTask = await createTask(second);
    const results = await Promise.all([
      claimAgentExecutionSlot(prisma, { agentId: first.agentId, taskId: firstTask.id }),
      claimAgentExecutionSlot(prisma, { agentId: second.agentId, taskId: secondTask.id }),
    ]);
    expect(results).toHaveLength(2);
    const agents = await prisma.agent.findMany({
      where: { id: { in: [first.agentId, second.agentId] } },
      select: { activeTaskId: true },
      orderBy: { name: 'asc' },
    });
    expect(agents.every((agent) => agent.activeTaskId !== null)).toBe(true);
  });

  it('allows at most one of two concurrent claims for the same Agent', async () => {
    const fixture = await createFixture('concurrent-claim');
    const first = await createTask(fixture);
    const second = await createTask(fixture);
    const results = await Promise.allSettled([
      claimAgentExecutionSlot(prisma, { agentId: fixture.agentId, taskId: first.id }),
      claimAgentExecutionSlot(prisma, { agentId: fixture.agentId, taskId: second.id }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const agent = await prisma.agent.findUniqueOrThrow({
      where: { id: fixture.agentId },
    });
    expect(agent.activeTaskId).not.toBeNull();
    expect(
      await prisma.buildTask.count({
        where: { agentId: fixture.agentId, status: BuildTaskStatus.DISPATCHED },
      }),
    ).toBe(1);
  });

  it('keeps Agent.activeTaskId synchronized with the claimed task', async () => {
    const fixture = await createFixture('active-pointer');
    const task = await createTask(fixture);
    await claimAgentExecutionSlot(prisma, { agentId: fixture.agentId, taskId: task.id });
    const stored = await prisma.agent.findUniqueOrThrow({
      where: { id: fixture.agentId },
    });
    expect(stored.activeTaskId).toBe(task.id);
  });

  it('stores large log, artifact and file sizes as PostgreSQL BIGINT/JavaScript bigint', async () => {
    const fixture = await createFixture('bigint');
    const task = await prisma.buildTask.create({
      data: {
        projectId: fixture.projectId,
        buildTemplateId: fixture.templateId,
        agentId: fixture.agentId,
        createdBy: fixture.userId,
        status: BuildTaskStatus.SUCCEEDED,
        branch: 'main',
        config: {},
        logSize: 5_000_000_000n,
        artifactCount: 3n,
        artifactBytes: 8_000_000_000n,
      },
    });
    const artifact = await prisma.artifact.create({
      data: {
        taskId: task.id,
        relativePath: 'dist/large.bin',
        fileName: 'large.bin',
        size: 8_000_000_000n,
        sha256: 'b'.repeat(64),
        storagePath: 'artifacts/large.bin',
      },
    });
    expect(typeof task.logSize).toBe('bigint');
    expect(typeof task.artifactBytes).toBe('bigint');
    expect(typeof artifact.size).toBe('bigint');
  });

  it('enforces unique relativePath within one task', async () => {
    const fixture = await createFixture('artifact-unique');
    const task = await createTask(fixture, BuildTaskStatus.SUCCEEDED);
    const data = {
      taskId: task.id,
      relativePath: 'dist/app.zip',
      fileName: 'app.zip',
      size: 1n,
      sha256: 'c'.repeat(64),
      storagePath: 'artifacts/app.zip',
    };
    await prisma.artifact.create({ data });
    await expect(prisma.artifact.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('does not cascade-delete tasks when referenced Agent, Project, or Template is deleted', async () => {
    const fixture = await createFixture('history');
    const task = await createTask(fixture, BuildTaskStatus.SUCCEEDED);
    await prisma.auditLog.create({
      data: {
        actorId: fixture.userId,
        action: 'TASK_CREATED',
        resourceType: 'BuildTask',
        resourceId: task.id,
        metadata: { safe: true },
      },
    });
    await expect(prisma.agent.delete({ where: { id: fixture.agentId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    await expect(prisma.project.delete({ where: { id: fixture.projectId } })).rejects.toMatchObject(
      {
        code: 'P2003',
      },
    );
    await expect(
      prisma.buildTemplate.delete({ where: { id: fixture.templateId } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.buildTask.findUnique({ where: { id: task.id } })).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { resourceId: task.id } })).toBe(1);
  });

  it('retains system audit logs when an actor User is physically deleted', async () => {
    const actor = await prisma.user.create({
      data: {
        username: `audit-actor-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        passwordHash: 'test-placeholder-hash',
      },
    });
    const audit = await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'SYSTEM_TEST',
        resourceType: 'Test',
        resourceId: randomUUID(),
        metadata: { safe: true },
      },
    });
    await prisma.user.delete({ where: { id: actor.id } });
    const retained = await prisma.auditLog.findUniqueOrThrow({ where: { id: audit.id } });
    expect(retained.actorId).toBeNull();
  });

  it('requires a dedicated test database and starts clean after reset', async () => {
    expect(databaseUrl).toContain('buildplatform_test');
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.agent.count()).toBe(0);
  });
});
