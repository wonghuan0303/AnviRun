import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AgentStatus, BuildTaskStatus, Prisma, UserRole } from '@prisma/client';
import {
  PROTOCOL_VERSION,
  TASK_LEASE_RECOVERY_WINDOW_SECONDS,
  validateProtocolMessage,
  type AgentCurrentTask,
  type TaskAssignmentMessage,
} from '@anvilrun/contracts';
import request from 'supertest';
import WebSocket from 'ws';

import { AppModule } from '../../src/app.module';
import { AgentConnectionRegistry } from '../../src/agents/agent-connection.registry';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PasswordService } from '../../src/auth/password.service';
import { PrismaService } from '../../src/database/prisma.service';
import { TaskLogsService } from '../../src/task-logs/task-logs.service';
import { TaskQueueService } from '../../src/tasks/task-queue.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Task WebSocket integration tests require buildplatform_test');
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

type ProtocolMessage = { type: string; payload: Record<string, unknown> };

describe('T4.1/T4.2/T4.3 task WebSocket PostgreSQL integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: TaskQueueService;
  let port: number;
  let adminToken: string;
  let adminId: string;
  let agentId: string;
  let agentToken: string;
  let templateId: string;
  let projectId: string;

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

  async function createTask(): Promise<{ id: string; status: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/projects/' + projectId + '/tasks')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});
    expect(response.status).toBe(201);
    return { id: response.body.task.id as string, status: response.body.task.status as string };
  }

  async function createQueuedTask(
    selectedTemplateId = templateId,
    config: Prisma.InputJsonValue = { channel: 'dev' },
    createdAt = new Date(),
  ) {
    return prisma.buildTask.create({
      data: {
        projectId,
        buildTemplateId: selectedTemplateId,
        agentId,
        createdBy: adminId,
        status: BuildTaskStatus.QUEUED,
        statusReason: null,
        branch: 'main',
        config,
        queuedAt: createdAt,
        createdAt,
      },
    });
  }

  async function createTemplate(
    name = 'task-ws-template-' + randomUUID(),
    options: { agentId?: string; formSchema?: Prisma.InputJsonValue } = {},
  ): Promise<string> {
    const template = await prisma.buildTemplate.create({
      data: {
        name,
        agentId: options.agentId ?? agentId,
        createdBy: adminId,
        gitUrl: 'https://example.invalid/task-ws.git',
        command: 'echo ws-build',
        artifactDir: 'dist',
        formSchema: options.formSchema ?? schema,
        timeoutSeconds: 60,
      },
    });
    return template.id;
  }

  async function claimTask(socket: WebSocket, taskId?: string): Promise<TaskAssignmentMessage> {
    const assignmentPromise = waitForMessage(socket, 'task.assignment');
    sendClaim(socket, randomUUID(), taskId);
    return (await assignmentPromise) as unknown as TaskAssignmentMessage;
  }

  function taskTransitions(
    history: ReadonlyArray<{ fromStatus: string | null; toStatus: string }>,
  ): string[] {
    return history.map((item) => (item.fromStatus ?? 'null') + '->' + item.toStatus);
  }

  async function expectInvalidHeadSkipped(
    socket: WebSocket,
    invalidTaskId: string,
    validTaskId: string,
    reason: string,
  ): Promise<void> {
    const assignment = await claimTask(socket);
    expect(assignment.payload.taskId).toBe(validTaskId);
    const failed = await prisma.buildTask.findUniqueOrThrow({ where: { id: invalidTaskId } });
    expect(failed.status).toBe(BuildTaskStatus.FAILED);
    expect(failed.leaseHash).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect(failed.statusReason).toContain(reason);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      validTaskId,
    );
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: invalidTaskId },
      select: { fromStatus: true, toStatus: true, source: true, reason: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining(['QUEUED->DISPATCHED', 'DISPATCHED->FAILED']),
    );
    expect(
      history
        .filter(
          (item) =>
            item.toStatus === BuildTaskStatus.DISPATCHED ||
            item.toStatus === BuildTaskStatus.FAILED,
        )
        .every(
          (item) => item.source === 'SYSTEM' && item.reason?.includes('Dispatch validation failed'),
        ),
    ).toBe(true);
  }

  function openSocket(): WebSocket {
    return new WebSocket('ws://127.0.0.1:' + port + '/ws/agent', {
      headers: { Authorization: 'Bearer ' + agentToken },
    });
  }

  async function waitForOpen(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async function waitForMessage(socket: WebSocket, type: string): Promise<ProtocolMessage> {
    return new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timeout: ' + type)), 5_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as ProtocolMessage;
        if (message.type !== type) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(message);
      };
      socket.on('message', onMessage);
    });
  }

  async function collectMessages(
    socket: WebSocket,
    type: string,
    durationMs: number,
  ): Promise<ProtocolMessage[]> {
    const messages: ProtocolMessage[] = [];
    await new Promise<void>((resolve) => {
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as ProtocolMessage;
        if (message.type === type) messages.push(message);
      };
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        resolve();
      }, durationMs);
      socket.on('message', onMessage);
      void timer;
    });
    return messages;
  }

  async function sendHello(
    socket: WebSocket,
    currentTask: AgentCurrentTask | null = null,
  ): Promise<void> {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'agent.hello',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          agentId,
          agentVersion: '4.1.0-test',
          hostname: 'task-host',
          os: 'linux',
          arch: 'x86_64',
          workspaceRoot: 'C:/agent-workspace',
          currentTask,
        },
      }),
    );
    await waitForMessage(socket, 'agent.registered');
  }

  function sendClaim(socket: WebSocket, id: string, taskId?: string): void {
    socket.send(
      JSON.stringify({
        id,
        type: 'task.claim',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: { agentId, ...(taskId === undefined ? {} : { taskId }) },
      }),
    );
  }

  function sendAccepted(socket: WebSocket, taskId: string, leaseToken: string): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.accepted',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: { taskId, leaseToken, acceptedAt: new Date().toISOString() },
      }),
    );
  }

  function sendPreparationStatus(
    socket: WebSocket,
    taskId: string,
    leaseToken: string,
    sourceCommit: string,
  ): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.status',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          taskId,
          leaseToken,
          status: 'PREPARING',
          occurredAt: new Date().toISOString(),
          sourceCommit,
        },
      }),
    );
  }

  function sendTaskStatus(
    socket: WebSocket,
    taskId: string,
    leaseToken: string,
    status: 'PREPARING' | 'RUNNING' | 'UPLOADING',
    sourceCommit?: string,
  ): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.status',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          taskId,
          leaseToken,
          status,
          occurredAt: new Date().toISOString(),
          ...(sourceCommit === undefined ? {} : { sourceCommit }),
        },
      }),
    );
  }

  function sendArtifactManifest(
    socket: WebSocket,
    taskId: string,
    leaseToken: string,
    content: Buffer,
  ): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.artifact-manifest',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          taskId,
          leaseToken,
          artifactDir: 'dist',
          totalBytes: content.length,
          files: [
            {
              relativePath: 'nested/app.txt',
              size: content.length,
              sha256: createHash('sha256').update(content).digest('hex'),
            },
          ],
        },
      }),
    );
  }

  function sendTaskCompleted(
    socket: WebSocket,
    taskId: string,
    leaseToken: string,
    artifactBytes: number,
  ): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.completed',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          taskId,
          leaseToken,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
          artifactCount: 1,
          artifactBytes,
          sourceCommit: '0123456789abcdef0123456789abcdef01234567',
        },
      }),
    );
  }

  function sendTaskFailure(
    socket: WebSocket,
    taskId: string,
    leaseToken: string,
    reason: string,
    exitCode?: number,
  ): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.failed',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          taskId,
          leaseToken,
          reason,
          failedAt: new Date().toISOString(),
          ...(exitCode === undefined ? {} : { exitCode }),
        },
      }),
    );
  }

  function sendTaskCanceled(socket: WebSocket, taskId: string, leaseToken: string): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.canceled',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          taskId,
          leaseToken,
          canceledAt: new Date().toISOString(),
          reason: 'cancelled by integration test',
        },
      }),
    );
  }

  function sendTaskLog(socket: WebSocket, taskId: string, leaseToken: string): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.log',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          taskId,
          leaseToken,
          sequence: 1,
          stream: 'stdout',
          chunk: 'bounded output',
          emittedAt: new Date().toISOString(),
        },
      }),
    );
  }

  function sendPreparationFailure(
    socket: WebSocket,
    taskId: string,
    leaseToken: string,
    reason: string,
  ): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.failed',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          taskId,
          leaseToken,
          reason,
          failedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async function waitForSourceCommit(taskId: string, sourceCommit: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const task = await prisma.buildTask.findUnique({ where: { id: taskId } });
      if (task?.sourceCommit === sourceCommit) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('task ' + taskId + ' did not persist source commit');
  }
  async function closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) socket.close();
    if (socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async function waitForClose(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function waitForTaskStatus(taskId: string, status: BuildTaskStatus): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const task = await prisma.buildTask.findUnique({ where: { id: taskId } });
      if (task?.status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('task ' + taskId + ' did not reach ' + status);
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    prisma = app.get(PrismaService);
    queue = app.get(TaskQueueService);
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    const admin = await prisma.user.create({
      data: {
        username: 'task-ws-admin',
        passwordHash: await passwords.hash('Task WS admin password 🔐'),
        role: UserRole.ADMIN,
      },
    });
    const user = await prisma.user.create({
      data: {
        username: 'task-ws-owner',
        passwordHash: await passwords.hash('Task WS owner password 🔐'),
      },
    });
    const agent = await prisma.agent.create({
      data: { name: 'task-ws-agent', enabled: true, status: AgentStatus.OFFLINE },
    });
    const template = await prisma.buildTemplate.create({
      data: {
        name: 'task-ws-template',
        agentId: agent.id,
        createdBy: admin.id,
        gitUrl: 'https://example.invalid/task-ws.git',
        command: 'echo ws-build',
        artifactDir: 'dist',
        formSchema: schema,
        timeoutSeconds: 60,
      },
    });
    const project = await prisma.project.create({
      data: {
        ownerId: user.id,
        buildTemplateId: template.id,
        name: 'Task WS Project',
        branch: 'main',
        config: {},
      },
    });
    adminId = admin.id;
    agentId = agent.id;
    templateId = template.id;
    projectId = project.id;
    app.get(LoginRateLimiterService).reset();
    adminToken = await login('task-ws-admin', 'Task WS admin password 🔐');
    const agentResponse = await request(app.getHttpServer())
      .post('/api/admin/agents')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'task-ws-connected-agent' });
    expect(agentResponse.status).toBe(201);
    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: { agentId: agentResponse.body.agent.id as string },
    });
    await prisma.project.update({
      where: { id: projectId },
      data: { buildTemplateId: templateId },
    });
    agentId = agentResponse.body.agent.id as string;
    agentToken = agentResponse.body.registrationToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('moves WAITING_AGENT to QUEUED after hello and sends task.available', async () => {
    const task = await createTask();
    expect(task.status).toBe('WAITING_AGENT');
    const socket = openSocket();
    await waitForOpen(socket);
    const available = waitForMessage(socket, 'task.available');
    await sendHello(socket);
    await available;
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      BuildTaskStatus.QUEUED,
    );
    await closeSocket(socket);
  });

  it('claims the oldest task transactionally and accepts it with a valid lease', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const available = waitForMessage(socket, 'task.available');
    const first = await createTask();
    await available;
    const assignment = await claimTask(socket, first.id);
    const validation = validateProtocolMessage(assignment);
    expect(validation.ok).toBe(true);
    expect(assignment.payload).toEqual(
      expect.objectContaining({
        taskId: first.id,
        agentId,
        projectId,
        buildTemplateId: templateId,
        command: 'echo ws-build',
        artifactDir: 'dist',
        timeoutSeconds: 60,
        git: { url: 'https://example.invalid/task-ws.git', branch: 'main' },
        config: { channel: 'dev' },
        sensitiveConfigKeys: [],
      }),
    );
    const claimed = await prisma.buildTask.findUniqueOrThrow({ where: { id: first.id } });
    expect(claimed.status).toBe(BuildTaskStatus.DISPATCHED);
    expect(claimed.leaseHash).toBeTruthy();
    expect(claimed.leaseHash).not.toBe(assignment.payload.leaseToken);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      first.id,
    );

    sendAccepted(socket, first.id, assignment.payload.leaseToken);
    await waitForTaskStatus(first.id, BuildTaskStatus.PREPARING);
    const historyCount = await prisma.buildTaskStatusHistory.count({ where: { taskId: first.id } });
    sendAccepted(socket, first.id, assignment.payload.leaseToken);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: first.id } })).toBe(
      historyCount,
    );
    await closeSocket(socket);
  });

  it('allows only one concurrent claim and duplicate claim does not consume the next task', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const first = await createTask();
    const second = await createTask();
    const firstClaimId = randomUUID();
    const secondClaimId = randomUUID();
    const [firstResult, secondResult] = await Promise.all([
      queue.claim(agentId, firstClaimId, first.id),
      queue.claim(agentId, secondClaimId, first.id),
    ]);
    const claimResults = [firstResult, secondResult];
    expect(claimResults.filter((result) => result !== null)).toHaveLength(1);
    const winner = firstResult ?? secondResult;
    if (!winner) throw new Error('expected one concurrent claim to win');
    expect(winner.payload.taskId).toBe(first.id);
    const winnerClaimId = firstResult ? firstClaimId : secondClaimId;

    const duplicatePromise = collectMessages(socket, 'task.assignment', 400);
    sendClaim(socket, winnerClaimId, first.id);
    const duplicateMessages = await duplicatePromise;
    expect(duplicateMessages).toHaveLength(1);
    expect(duplicateMessages[0]?.payload.taskId).toBe(first.id);
    expect(
      await prisma.buildTask.count({ where: { agentId, status: BuildTaskStatus.DISPATCHED } }),
    ).toBe(1);
    expect(
      await prisma.buildTaskStatusHistory.count({
        where: { taskId: first.id, toStatus: BuildTaskStatus.DISPATCHED },
      }),
    ).toBe(1);
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      BuildTaskStatus.QUEUED,
    );
    await closeSocket(socket);
  });

  it('fails a task whose template was disabled after creation and claims the next valid task', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const invalid = await createQueuedTask(
      templateId,
      { channel: 'dev' },
      new Date(Date.now() - 1_000),
    );
    await prisma.buildTemplate.update({ where: { id: templateId }, data: { enabled: false } });
    const validTemplateId = await createTemplate();
    const valid = await createQueuedTask(validTemplateId);
    await expectInvalidHeadSkipped(socket, invalid.id, valid.id, 'Build template is disabled');
    await closeSocket(socket);
  });

  it('fails a task whose template Agent binding changed and claims the next valid task', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const invalid = await createQueuedTask(
      templateId,
      { channel: 'dev' },
      new Date(Date.now() - 1_000),
    );
    const otherAgent = await prisma.agent.create({
      data: {
        name: 'task-ws-other-agent-' + randomUUID(),
        enabled: true,
        status: AgentStatus.OFFLINE,
      },
    });
    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: { agentId: otherAgent.id },
    });
    const validTemplateId = await createTemplate();
    const valid = await createQueuedTask(validTemplateId);
    await expectInvalidHeadSkipped(
      socket,
      invalid.id,
      valid.id,
      'Build template Agent binding changed',
    );
    await closeSocket(socket);
  });

  it('fails a task with an invalid current template schema and claims the next valid task', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const invalid = await createQueuedTask(
      templateId,
      { channel: 'dev' },
      new Date(Date.now() - 1_000),
    );
    await prisma.buildTemplate.update({ where: { id: templateId }, data: { formSchema: {} } });
    const validTemplateId = await createTemplate();
    const valid = await createQueuedTask(validTemplateId);
    await expectInvalidHeadSkipped(
      socket,
      invalid.id,
      valid.id,
      'Build template schema is invalid',
    );
    await closeSocket(socket);
  });

  it('fails a task incompatible with the current schema and claims the next valid task', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const invalid = await createQueuedTask(
      templateId,
      { channel: 123 },
      new Date(Date.now() - 1_000),
    );
    const validTemplateId = await createTemplate();
    const valid = await createQueuedTask(validTemplateId);
    await expectInvalidHeadSkipped(
      socket,
      invalid.id,
      valid.id,
      'Task configuration is no longer compatible',
    );
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: invalid.id },
      select: { reason: true },
    });
    expect(history.every((item) => !item.reason?.includes('123'))).toBe(true);
    await closeSocket(socket);
  });

  it('rejects wrong leases, then accepts the correct lease without changing active slot', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken + 'wrong');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      BuildTaskStatus.DISPATCHED,
    );
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      task.id,
    );
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    const historyCount = await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } });
    await expect(
      queue.accept(agentId, task.id, assignment.payload.leaseToken + 'wrong'),
    ).rejects.toMatchObject({
      code: 'TASK_LEASE_INVALID',
    });
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      BuildTaskStatus.PREPARING,
    );
    await prisma.buildTask.update({
      where: { id: task.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(
      queue.accept(agentId, task.id, assignment.payload.leaseToken),
    ).rejects.toMatchObject({
      code: 'TASK_LEASE_INVALID',
    });
    await prisma.agent.update({ where: { id: agentId }, data: { activeTaskId: null } });
    await expect(
      queue.accept(agentId, task.id, assignment.payload.leaseToken),
    ).rejects.toMatchObject({
      code: 'TASK_LEASE_INVALID',
    });
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      BuildTaskStatus.PREPARING,
    );
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      historyCount,
    );
    await closeSocket(socket);
  });

  it('recovers an unaccepted DISPATCHED task through QUEUED to WAITING_AGENT on disconnect', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    await claimTask(socket, task.id);

    await closeSocket(socket);
    await waitForTaskStatus(task.id, BuildTaskStatus.WAITING_AGENT);
    const recovered = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(recovered.leaseHash).toBeNull();
    expect(recovered.leaseExpiresAt).toBeNull();
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: task.id },
      select: { fromStatus: true, toStatus: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining(['DISPATCHED->QUEUED', 'QUEUED->WAITING_AGENT']),
    );
  });

  it('reclaims an offline DISPATCHED timeout through QUEUED to WAITING_AGENT', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    await claimTask(socket, task.id);
    await prisma.agent.update({ where: { id: agentId }, data: { status: AgentStatus.OFFLINE } });

    await queue.reclaimTimedOutDispatches(new Date(Date.now() + 31_000));
    const reclaimed = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(reclaimed.status).toBe(BuildTaskStatus.WAITING_AGENT);
    expect(reclaimed.leaseHash).toBeNull();
    expect(reclaimed.leaseExpiresAt).toBeNull();
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: task.id },
      select: { fromStatus: true, toStatus: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining(['DISPATCHED->QUEUED', 'QUEUED->WAITING_AGENT']),
    );
    await closeSocket(socket);
  });

  it('recovers queued and unaccepted dispatched sibling tasks without rolling back either', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const dispatched = await createTask();
    const queued = await createTask();
    await claimTask(socket, dispatched.id);

    await queue.onAgentDisconnected(agentId);
    const [dispatchedAfter, queuedAfter] = await Promise.all([
      prisma.buildTask.findUniqueOrThrow({ where: { id: dispatched.id } }),
      prisma.buildTask.findUniqueOrThrow({ where: { id: queued.id } }),
    ]);
    expect(dispatchedAfter.status).toBe(BuildTaskStatus.WAITING_AGENT);
    expect(queuedAfter.status).toBe(BuildTaskStatus.WAITING_AGENT);
    expect(dispatchedAfter.leaseHash).toBeNull();
    expect(dispatchedAfter.leaseExpiresAt).toBeNull();
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();
    const dispatchedHistory = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: dispatched.id },
      select: { fromStatus: true, toStatus: true },
    });
    expect(taskTransitions(dispatchedHistory)).toEqual(
      expect.arrayContaining(['DISPATCHED->QUEUED', 'QUEUED->WAITING_AGENT']),
    );
    await closeSocket(socket);
  });

  it('notifies an already QUEUED task when an Agent reconnects', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);
    const task = await createTask();
    await waitForTaskStatus(task.id, BuildTaskStatus.QUEUED);
    const historyCount = await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } });
    const registry = app.get(AgentConnectionRegistry);
    const currentSocket = registry.get(agentId);
    expect(currentSocket).toBeDefined();
    if (currentSocket) {
      expect(registry.unregister(agentId, currentSocket)).toBe(true);
      await closeSocket(currentSocket);
    }
    await closeSocket(firstSocket);

    const secondSocket = openSocket();
    await waitForOpen(secondSocket);
    const available = waitForMessage(secondSocket, 'task.available');
    await sendHello(secondSocket);
    const availableMessage = await available;
    expect(availableMessage.payload.queuedTaskCount).toBe(1);
    const persisted = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(persisted.status).toBe(BuildTaskStatus.QUEUED);
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      historyCount,
    );
    await closeSocket(secondSocket);
  });

  it('does not let an old socket close affect a replacement connection', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);
    const task = await createTask();
    const assignment = await claimTask(firstSocket, task.id);
    sendAccepted(firstSocket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const secondSocket = openSocket();
    await waitForOpen(secondSocket);
    const recovery = waitForMessage(secondSocket, 'task.recovery');
    await sendHello(secondSocket, {
      taskId: task.id,
      leaseToken: assignment.payload.leaseToken,
      status: 'PREPARING',
      lastLogSequence: 0,
    });
    await expect(recovery).resolves.toMatchObject({
      payload: { taskId: task.id, action: 'RESUME', status: 'PREPARING' },
    });
    await waitForClose(firstSocket);

    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).status).toBe(
      AgentStatus.ONLINE,
    );
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      task.id,
    );
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      BuildTaskStatus.PREPARING,
    );

    const resultAck = waitForMessage(secondSocket, 'task.result.ack');
    sendPreparationFailure(
      secondSocket,
      task.id,
      assignment.payload.leaseToken,
      'GIT_CLONE_FAILED: replacement connection cleanup',
    );
    await expect(resultAck).resolves.toMatchObject({
      payload: { taskId: task.id, status: 'FAILED' },
    });
    await closeSocket(secondSocket);
  });

  it('serializes log persistence before a terminal failure on the same socket', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const logs = app.get(TaskLogsService);
    const originalAppend = logs.appendFromAgent.bind(logs);
    const append = jest
      .spyOn(logs, 'appendFromAgent')
      .mockImplementation(async (agent, message) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return originalAppend(agent, message);
      });
    const order: string[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as ProtocolMessage;
      if (message.type === 'task.log.ack' || message.type === 'task.result.ack') {
        order.push(message.type);
      }
    };
    socket.on('message', onMessage);
    try {
      const logAck = waitForMessage(socket, 'task.log.ack');
      const resultAck = waitForMessage(socket, 'task.result.ack');
      sendTaskLog(socket, task.id, assignment.payload.leaseToken);
      sendTaskFailure(socket, task.id, assignment.payload.leaseToken, 'COMMAND_FAILED: ordered');
      await expect(logAck).resolves.toMatchObject({
        payload: { taskId: task.id, acknowledgedSequence: 1 },
      });
      await expect(resultAck).resolves.toMatchObject({
        payload: { taskId: task.id, status: 'FAILED' },
      });
      expect(order).toEqual(['task.log.ack', 'task.result.ack']);
      const persisted = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(persisted.status).toBe(BuildTaskStatus.FAILED);
      expect(persisted.lastLogSequence).toBe(1n);
      expect(Number(persisted.logSize)).toBeGreaterThan(0);
      const history = await prisma.buildTaskStatusHistory.findMany({
        where: { taskId: task.id, toStatus: BuildTaskStatus.FAILED },
      });
      expect(history).toHaveLength(1);
    } finally {
      socket.off('message', onMessage);
      append.mockRestore();
      await closeSocket(socket);
    }
  });

  it('drops queued messages from an old socket after a replacement takes ownership', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);
    const task = await createTask();
    const assignment = await claimTask(firstSocket, task.id);
    sendAccepted(firstSocket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    let releaseAppend!: () => void;
    let appendStarted!: () => void;
    const appendBlocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const started = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    const logs = app.get(TaskLogsService);
    const originalAppend = logs.appendFromAgent.bind(logs);
    const append = jest
      .spyOn(logs, 'appendFromAgent')
      .mockImplementation(async (agent, message) => {
        appendStarted();
        await appendBlocked;
        return originalAppend(agent, message);
      });
    try {
      sendTaskLog(firstSocket, task.id, assignment.payload.leaseToken);
      await started;
      sendTaskFailure(firstSocket, task.id, assignment.payload.leaseToken, 'COMMAND_FAILED: stale');

      const secondSocket = openSocket();
      await waitForOpen(secondSocket);
      const recovery = waitForMessage(secondSocket, 'task.recovery');
      await sendHello(secondSocket, {
        taskId: task.id,
        leaseToken: assignment.payload.leaseToken,
        status: 'PREPARING',
        lastLogSequence: 0,
      });
      await expect(recovery).resolves.toMatchObject({
        payload: { taskId: task.id, action: 'RESUME', status: 'PREPARING' },
      });
      releaseAppend();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
        BuildTaskStatus.PREPARING,
      );

      const resultAck = waitForMessage(secondSocket, 'task.result.ack');
      sendPreparationFailure(
        secondSocket,
        task.id,
        assignment.payload.leaseToken,
        'GIT_CLONE_FAILED: replacement cleanup',
      );
      await expect(resultAck).resolves.toMatchObject({
        payload: { taskId: task.id, status: 'FAILED' },
      });
      await closeSocket(secondSocket);
    } finally {
      append.mockRestore();
      releaseAppend();
      await closeSocket(firstSocket);
    }
  });

  it('reconciles a live PREPARING task after a short disconnect without rerunning it', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);
    const task = await createTask();
    const assignment = await claimTask(firstSocket, task.id);
    sendAccepted(firstSocket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const logAck = waitForMessage(firstSocket, 'task.log.ack');
    sendTaskLog(firstSocket, task.id, assignment.payload.leaseToken);
    await expect(logAck).resolves.toMatchObject({
      payload: { taskId: task.id, acknowledgedSequence: 1 },
    });
    await closeSocket(firstSocket);
    await waitForTaskStatus(task.id, BuildTaskStatus.AGENT_LOST);

    const lost = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(lost.leaseHash).not.toBeNull();
    expect(lost.leaseExpiresAt).not.toBeNull();
    expect(lost.lastLogSequence).toBe(1n);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      task.id,
    );
    const lostHistoryCount = await prisma.buildTaskStatusHistory.count({
      where: { taskId: task.id },
    });

    const secondSocket = openSocket();
    await waitForOpen(secondSocket);
    const recovery = waitForMessage(secondSocket, 'task.recovery');
    await sendHello(secondSocket, {
      taskId: task.id,
      leaseToken: assignment.payload.leaseToken,
      status: 'PREPARING',
      lastLogSequence: 1,
    });
    await expect(recovery).resolves.toMatchObject({
      payload: {
        taskId: task.id,
        action: 'RESUME',
        status: 'PREPARING',
        acknowledgedLogSequence: 1,
      },
    });
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      lostHistoryCount + 1,
    );
    const resumed = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(resumed.leaseHash).not.toBeNull();
    expect(resumed.leaseExpiresAt).not.toBeNull();
    expect(resumed.recoveryStatus).toBeNull();
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      task.id,
    );

    const resultAck = waitForMessage(secondSocket, 'task.result.ack');
    sendPreparationFailure(
      secondSocket,
      task.id,
      assignment.payload.leaseToken,
      'GIT_CLONE_FAILED: recovery test cleanup',
    );
    await expect(resultAck).resolves.toMatchObject({
      payload: { taskId: task.id, status: 'FAILED' },
    });
    await waitForTaskStatus(task.id, BuildTaskStatus.FAILED);
    await closeSocket(secondSocket);
  });

  it('fails an orphaned active task when the Agent restarts without currentTask', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);
    const task = await createTask();
    const assignment = await claimTask(firstSocket, task.id);
    sendAccepted(firstSocket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    await closeSocket(firstSocket);
    await waitForTaskStatus(task.id, BuildTaskStatus.AGENT_LOST);

    const secondSocket = openSocket();
    await waitForOpen(secondSocket);
    await sendHello(secondSocket);
    await waitForTaskStatus(task.id, BuildTaskStatus.FAILED);

    const failed = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(failed.leaseHash).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect(failed.recoveryStatus).toBeNull();
    expect(failed.recoveryDeadlineAt).toBeNull();
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: task.id },
      select: { fromStatus: true, toStatus: true, source: true, reason: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining(['PREPARING->AGENT_LOST', 'AGENT_LOST->FAILED']),
    );
    expect(history.find((item) => item.toStatus === BuildTaskStatus.FAILED)).toEqual(
      expect.objectContaining({
        source: 'SYSTEM',
        reason: 'Agent restarted without a resumable local task; execution was abandoned',
      }),
    );

    const followUp = await createTask();
    const followUpAssignment = await claimTask(secondSocket, followUp.id);
    expect(followUpAssignment.payload.taskId).toBe(followUp.id);
    await closeSocket(secondSocket);
  });

  it('expires a lost task once and releases its lease and execution slot', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);
    const task = await createTask();
    const assignment = await claimTask(firstSocket, task.id);
    sendAccepted(firstSocket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    await closeSocket(firstSocket);
    await waitForTaskStatus(task.id, BuildTaskStatus.AGENT_LOST);

    const deadline = new Date(Date.now() + (TASK_LEASE_RECOVERY_WINDOW_SECONDS + 1) * 1_000);
    await queue.reclaimTimedOutDispatches(deadline);
    await waitForTaskStatus(task.id, BuildTaskStatus.FAILED);
    const historyCount = await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } });
    await queue.reclaimTimedOutDispatches(deadline);
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      historyCount,
    );
    const failed = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(failed.leaseHash).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();
  });

  it('persists task creation idempotency across concurrent and repeated requests', async () => {
    const key = 't6-creation-' + randomUUID();
    const create = () =>
      request(app.getHttpServer())
        .post('/api/projects/' + projectId + '/tasks')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Idempotency-Key', key)
        .send({});
    const [first, second] = await Promise.all([create(), create()]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.task.id).toBe(second.body.task.id);
    expect(
      await prisma.buildTask.count({ where: { projectId, creationIdempotencyKey: key } }),
    ).toBe(1);

    const repeated = await create();
    expect(repeated.status).toBe(201);
    expect(repeated.body.task.id).toBe(first.body.task.id);
  });

  it('reclaims dispatch timeout, clears lease and returns an online task to QUEUED', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    await claimTask(socket, task.id);
    await queue.reclaimTimedOutDispatches(new Date(Date.now() + 31_000));
    const reclaimed = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(reclaimed.status).toBe(BuildTaskStatus.QUEUED);
    expect(reclaimed.leaseHash).toBeNull();
    expect(reclaimed.leaseExpiresAt).toBeNull();
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();
    await closeSocket(socket);
  });

  it('disconnects queued tasks back to WAITING_AGENT and heartbeat cannot claim a queued task', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'agent.heartbeat',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: { agentId, currentTaskId: task.id },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();
    await closeSocket(socket);
    await waitForTaskStatus(task.id, BuildTaskStatus.WAITING_AGENT);
  });

  it('stores preparation sourceCommit idempotently and rejects invalid reports', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const sourceCommit = 'A'.repeat(40).toLowerCase();
    sendPreparationStatus(
      socket,
      task.id,
      assignment.payload.leaseToken,
      sourceCommit.toUpperCase(),
    );
    await waitForSourceCommit(task.id, sourceCommit);
    const historyCount = await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } });

    sendPreparationStatus(socket, task.id, assignment.payload.leaseToken, sourceCommit);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      historyCount,
    );

    sendPreparationStatus(socket, task.id, assignment.payload.leaseToken, 'not-a-commit');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const persisted = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(persisted.status).toBe(BuildTaskStatus.PREPARING);
    expect(persisted.sourceCommit).toBe(sourceCommit);
    await closeSocket(socket);
  });

  it('fails a preparing task, clears its lease, and notifies the next queued task', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const first = await createTask();
    const firstAssignment = await claimTask(socket, first.id);
    sendAccepted(socket, first.id, firstAssignment.payload.leaseToken);
    await waitForTaskStatus(first.id, BuildTaskStatus.PREPARING);
    const second = await createTask();
    await waitForTaskStatus(second.id, BuildTaskStatus.QUEUED);

    const available = waitForMessage(socket, 'task.available');
    const reason = 'GIT_CLONE_FAILED: Git clone failed';
    sendPreparationFailure(socket, first.id, firstAssignment.payload.leaseToken, reason);
    const availableMessage = await available;
    expect(availableMessage.payload.queuedTaskCount).toBeGreaterThanOrEqual(1);
    await waitForTaskStatus(first.id, BuildTaskStatus.FAILED);

    const failed = await prisma.buildTask.findUniqueOrThrow({ where: { id: first.id } });
    expect(failed.leaseHash).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect(failed.finishedAt).not.toBeNull();
    expect(failed.statusReason).toBe(reason);
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: first.id },
      select: { fromStatus: true, toStatus: true, source: true, reason: true },
    });
    expect(taskTransitions(history)).toEqual(expect.arrayContaining(['PREPARING->FAILED']));
    expect(history.find((item) => item.toStatus === BuildTaskStatus.FAILED)).toEqual(
      expect.objectContaining({ source: 'AGENT', reason }),
    );

    const historyCount = history.length;
    sendPreparationFailure(socket, first.id, firstAssignment.payload.leaseToken, reason);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: first.id } })).toBe(
      historyCount,
    );
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      BuildTaskStatus.QUEUED,
    );
    await closeSocket(socket);
  });

  it('finalizes PREPARING after disconnect and lets the Agent reclaim the next task', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);

    const first = await createTask();
    const firstAssignment = await claimTask(firstSocket, first.id);
    sendAccepted(firstSocket, first.id, firstAssignment.payload.leaseToken);
    await waitForTaskStatus(first.id, BuildTaskStatus.PREPARING);

    const second = await createQueuedTask();
    await closeSocket(firstSocket);

    await waitForTaskStatus(first.id, BuildTaskStatus.AGENT_LOST);
    await queue.reclaimTimedOutDispatches(
      new Date(Date.now() + (TASK_LEASE_RECOVERY_WINDOW_SECONDS + 1) * 1_000),
    );
    await waitForTaskStatus(first.id, BuildTaskStatus.FAILED);
    await waitForTaskStatus(second.id, BuildTaskStatus.WAITING_AGENT);

    const failed = await prisma.buildTask.findUniqueOrThrow({ where: { id: first.id } });
    expect(failed.leaseHash).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect(failed.finishedAt).not.toBeNull();

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.activeTaskId).toBeNull();

    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: first.id },
      orderBy: { occurredAt: 'asc' },
      select: { fromStatus: true, toStatus: true, source: true, reason: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining(['PREPARING->AGENT_LOST', 'AGENT_LOST->FAILED']),
    );
    expect(
      history
        .filter(
          (item) =>
            item.toStatus === BuildTaskStatus.AGENT_LOST ||
            item.toStatus === BuildTaskStatus.FAILED,
        )
        .every((item) => item.source === 'SYSTEM' && item.reason?.toLowerCase().includes('agent')),
    ).toBe(true);

    const historyCount = history.length;
    await queue.onAgentDisconnected(agentId);
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: first.id } })).toBe(
      historyCount,
    );
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      BuildTaskStatus.FAILED,
    );

    const secondSocket = openSocket();
    await waitForOpen(secondSocket);
    const available = waitForMessage(secondSocket, 'task.available');
    await sendHello(secondSocket);
    const availableMessage = await available;
    expect(availableMessage.payload.queuedTaskCount).toBeGreaterThanOrEqual(1);
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      BuildTaskStatus.QUEUED,
    );

    const secondAssignment = await claimTask(secondSocket, second.id);
    expect(secondAssignment.payload.taskId).toBe(second.id);
    await closeSocket(secondSocket);
  });

  it('transitions RUNNING and UPLOADING idempotently and accepts bounded task logs', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const sourceCommit = 'b'.repeat(40);
    sendPreparationStatus(socket, task.id, assignment.payload.leaseToken, sourceCommit);
    await waitForSourceCommit(task.id, sourceCommit);
    const preparingHistoryCount = await prisma.buildTaskStatusHistory.count({
      where: { taskId: task.id },
    });

    sendTaskStatus(socket, task.id, assignment.payload.leaseToken, 'RUNNING', sourceCommit);
    await waitForTaskStatus(task.id, BuildTaskStatus.RUNNING);
    const runningHistoryCount = await prisma.buildTaskStatusHistory.count({
      where: { taskId: task.id },
    });
    expect(runningHistoryCount).toBe(preparingHistoryCount + 1);

    sendTaskStatus(socket, task.id, assignment.payload.leaseToken, 'RUNNING', sourceCommit);
    sendTaskLog(socket, task.id, assignment.payload.leaseToken);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      runningHistoryCount,
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const running = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(running.leaseHash).not.toBeNull();
    expect(running.leaseExpiresAt).not.toBeNull();
    expect(running.startedAt).not.toBeNull();

    sendTaskStatus(socket, task.id, assignment.payload.leaseToken, 'UPLOADING', sourceCommit);
    await waitForTaskStatus(task.id, BuildTaskStatus.UPLOADING);
    const uploadingHistoryCount = await prisma.buildTaskStatusHistory.count({
      where: { taskId: task.id },
    });
    sendTaskStatus(socket, task.id, assignment.payload.leaseToken, 'UPLOADING', sourceCommit);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      uploadingHistoryCount,
    );

    await closeSocket(socket);
    await waitForTaskStatus(task.id, BuildTaskStatus.AGENT_LOST);
    await queue.reclaimTimedOutDispatches(
      new Date(Date.now() + (TASK_LEASE_RECOVERY_WINDOW_SECONDS + 1) * 1_000),
    );
    await waitForTaskStatus(task.id, BuildTaskStatus.FAILED);
    const failed = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(failed.leaseHash).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect(failed.finishedAt).not.toBeNull();
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      null,
    );
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: task.id },
      orderBy: { occurredAt: 'asc' },
      select: { fromStatus: true, toStatus: true, source: true, reason: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining([
        'PREPARING->RUNNING',
        'RUNNING->UPLOADING',
        'UPLOADING->AGENT_LOST',
        'AGENT_LOST->FAILED',
      ]),
    );
    expect(
      history
        .filter(
          (item) =>
            item.toStatus === BuildTaskStatus.AGENT_LOST ||
            item.toStatus === BuildTaskStatus.FAILED,
        )
        .every(
          (item) =>
            item.source === 'SYSTEM' &&
            (item.toStatus === BuildTaskStatus.AGENT_LOST
              ? item.reason?.toLowerCase().includes('disconnect')
              : item.reason?.toLowerCase().includes('recovery window')) &&
            !item.reason?.includes(assignment.payload.leaseToken),
        ),
    ).toBe(true);
    const historyCount = history.length;
    await queue.onAgentDisconnected(agentId);
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      historyCount,
    );
  });

  it('fails a RUNNING task with exitCode, clears its lease, and preserves queue progress', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const first = await createTask();
    const assignment = await claimTask(socket, first.id);
    sendAccepted(socket, first.id, assignment.payload.leaseToken);
    await waitForTaskStatus(first.id, BuildTaskStatus.PREPARING);
    const sourceCommit = 'c'.repeat(40);
    sendPreparationStatus(socket, first.id, assignment.payload.leaseToken, sourceCommit);
    await waitForSourceCommit(first.id, sourceCommit);

    sendTaskStatus(
      socket,
      first.id,
      assignment.payload.leaseToken + '-wrong',
      'RUNNING',
      sourceCommit,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      BuildTaskStatus.PREPARING,
    );
    sendTaskStatus(socket, first.id, assignment.payload.leaseToken, 'RUNNING', sourceCommit);
    await waitForTaskStatus(first.id, BuildTaskStatus.RUNNING);

    const second = await createTask();
    await waitForTaskStatus(second.id, BuildTaskStatus.QUEUED);
    const available = waitForMessage(socket, 'task.available');
    sendTaskFailure(
      socket,
      first.id,
      assignment.payload.leaseToken,
      'COMMAND_FAILED: command exited with non-zero status',
      7,
    );
    await available;
    await waitForTaskStatus(first.id, BuildTaskStatus.FAILED);

    const failed = await prisma.buildTask.findUniqueOrThrow({ where: { id: first.id } });
    expect(failed.exitCode).toBe(7);
    expect(failed.leaseHash).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect(failed.finishedAt).not.toBeNull();
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      null,
    );
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      BuildTaskStatus.QUEUED,
    );
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: first.id },
      select: { fromStatus: true, toStatus: true, source: true, reason: true },
    });
    expect(taskTransitions(history)).toEqual(expect.arrayContaining(['RUNNING->FAILED']));
    expect(history.find((item) => item.toStatus === BuildTaskStatus.FAILED)).toEqual(
      expect.objectContaining({ source: 'AGENT' }),
    );
    await closeSocket(socket);
  });

  it('finalizes RUNNING disconnect and lets a reconnected Agent claim the next task', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);
    const first = await createTask();
    const assignment = await claimTask(firstSocket, first.id);
    sendAccepted(firstSocket, first.id, assignment.payload.leaseToken);
    await waitForTaskStatus(first.id, BuildTaskStatus.PREPARING);
    const sourceCommit = 'd'.repeat(40);
    sendPreparationStatus(firstSocket, first.id, assignment.payload.leaseToken, sourceCommit);
    await waitForSourceCommit(first.id, sourceCommit);
    sendTaskStatus(firstSocket, first.id, assignment.payload.leaseToken, 'RUNNING', sourceCommit);
    await waitForTaskStatus(first.id, BuildTaskStatus.RUNNING);

    const second = await createQueuedTask();
    await closeSocket(firstSocket);
    await waitForTaskStatus(first.id, BuildTaskStatus.AGENT_LOST);
    await queue.reclaimTimedOutDispatches(
      new Date(Date.now() + (TASK_LEASE_RECOVERY_WINDOW_SECONDS + 1) * 1_000),
    );
    await waitForTaskStatus(first.id, BuildTaskStatus.FAILED);
    await waitForTaskStatus(second.id, BuildTaskStatus.WAITING_AGENT);

    const failedHistory = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: first.id },
      orderBy: { occurredAt: 'asc' },
      select: { fromStatus: true, toStatus: true, source: true, reason: true },
    });
    expect(taskTransitions(failedHistory)).toEqual(
      expect.arrayContaining(['RUNNING->AGENT_LOST', 'AGENT_LOST->FAILED']),
    );
    expect(
      failedHistory
        .filter(
          (item) =>
            item.toStatus === BuildTaskStatus.AGENT_LOST ||
            item.toStatus === BuildTaskStatus.FAILED,
        )
        .every((item) => item.source === 'SYSTEM'),
    ).toBe(true);
    expect(
      (await prisma.buildTask.findUniqueOrThrow({ where: { id: first.id } })).leaseHash,
    ).toBeNull();
    expect(
      (await prisma.buildTask.findUniqueOrThrow({ where: { id: first.id } })).leaseExpiresAt,
    ).toBeNull();
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId,
    ).toBeNull();

    const historyCount = failedHistory.length;
    await queue.onAgentDisconnected(agentId);
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: first.id } })).toBe(
      historyCount,
    );

    const secondSocket = openSocket();
    await waitForOpen(secondSocket);
    const available = waitForMessage(secondSocket, 'task.available');
    await sendHello(secondSocket);
    const availableMessage = await available;
    expect(availableMessage.payload.queuedTaskCount).toBe(1);
    const nextAssignment = await claimTask(secondSocket, second.id);
    expect(nextAssignment.payload.taskId).toBe(second.id);
    await closeSocket(secondSocket);
  });

  it('cancels an accepted task after validating the lease and clears the execution slot', async () => {
    const task = await createTask();
    const socket = openSocket();
    await waitForOpen(socket);
    const available = waitForMessage(socket, 'task.available');
    await sendHello(socket);
    await available;
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const cancelMessagePromise = waitForMessage(socket, 'task.cancel');
    const cancel = await request(app.getHttpServer())
      .post('/api/tasks/' + task.id + '/cancel')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ reason: 'user requested cancellation' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.task.status).toBe('CANCELING');
    const cancelMessage = await cancelMessagePromise;
    expect(cancelMessage.payload.taskId).toBe(task.id);
    expect(cancelMessage.payload.leaseToken).toBe(assignment.payload.leaseToken);

    sendTaskCanceled(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.CANCELED);
    const stored = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.leaseHash).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toEqual(
      expect.objectContaining({ activeTaskId: null }),
    );
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: task.id },
      select: { fromStatus: true, toStatus: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining(['PREPARING->CANCELING', 'CANCELING->CANCELED']),
    );

    const historyCount = history.length;
    sendTaskCanceled(socket, task.id, assignment.payload.leaseToken);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      historyCount,
    );
    await closeSocket(socket);
  });

  it('keeps CANCELING across disconnect and completes cancellation after recovery', async () => {
    const task = await createTask();
    const socket = openSocket();
    await waitForOpen(socket);
    const available = waitForMessage(socket, 'task.available');
    await sendHello(socket);
    await available;
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    const cancelMessagePromise = waitForMessage(socket, 'task.cancel');
    const cancel = await request(app.getHttpServer())
      .post('/api/tasks/' + task.id + '/cancel')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});
    expect(cancel.body.task.status).toBe('CANCELING');
    await cancelMessagePromise;

    sendTaskCanceled(socket, task.id, assignment.payload.leaseToken + 'wrong');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      BuildTaskStatus.CANCELING,
    );
    await closeSocket(socket);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      BuildTaskStatus.CANCELING,
    );

    const reconnected = openSocket();
    await waitForOpen(reconnected);
    const recovery = waitForMessage(reconnected, 'task.recovery');
    await sendHello(reconnected, {
      taskId: task.id,
      leaseToken: assignment.payload.leaseToken,
      status: 'PREPARING',
      lastLogSequence: 0,
    });
    await expect(recovery).resolves.toMatchObject({
      payload: { taskId: task.id, action: 'CANCEL', status: 'PREPARING' },
    });
    sendTaskCanceled(reconnected, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.CANCELED);
    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: task.id },
      select: { fromStatus: true, toStatus: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining(['PREPARING->CANCELING', 'CANCELING->CANCELED']),
    );
    expect(taskTransitions(history)).not.toContain('CANCELING->FAILED');
    expect(history.filter((item) => item.toStatus === BuildTaskStatus.CANCELED)).toHaveLength(1);
    await closeSocket(reconnected);
  });

  it('recovers an AGENT_LOST cancellation with CANCEL instead of resuming execution', async () => {
    const firstSocket = openSocket();
    await waitForOpen(firstSocket);
    await sendHello(firstSocket);
    const task = await createTask();
    const assignment = await claimTask(firstSocket, task.id);
    sendAccepted(firstSocket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    const sourceCommit = 'e'.repeat(40);
    sendPreparationStatus(firstSocket, task.id, assignment.payload.leaseToken, sourceCommit);
    await waitForSourceCommit(task.id, sourceCommit);
    sendTaskStatus(firstSocket, task.id, assignment.payload.leaseToken, 'RUNNING', sourceCommit);
    await waitForTaskStatus(task.id, BuildTaskStatus.RUNNING);
    await closeSocket(firstSocket);
    await waitForTaskStatus(task.id, BuildTaskStatus.AGENT_LOST);

    const cancel = await request(app.getHttpServer())
      .post('/api/tasks/' + task.id + '/cancel')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ reason: 'cancel while agent was lost' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.task.status).toBe(BuildTaskStatus.CANCELING);

    const secondSocket = openSocket();
    await waitForOpen(secondSocket);
    const recovery = waitForMessage(secondSocket, 'task.recovery');
    await sendHello(secondSocket, {
      taskId: task.id,
      leaseToken: assignment.payload.leaseToken,
      status: 'RUNNING',
      lastLogSequence: 0,
    });
    await expect(recovery).resolves.toMatchObject({
      payload: { taskId: task.id, action: 'CANCEL', status: 'RUNNING' },
    });
    sendTaskCanceled(secondSocket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.CANCELED);

    const history = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: task.id },
      select: { fromStatus: true, toStatus: true },
    });
    expect(taskTransitions(history)).toEqual(
      expect.arrayContaining([
        'RUNNING->AGENT_LOST',
        'AGENT_LOST->CANCELING',
        'CANCELING->CANCELED',
      ]),
    );
    expect(taskTransitions(history)).not.toContain('AGENT_LOST->FAILED');
    expect(history.filter((item) => item.toStatus === BuildTaskStatus.CANCELED)).toHaveLength(1);
    expect(await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).toEqual(
      expect.objectContaining({ leaseHash: null, leaseExpiresAt: null }),
    );
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toEqual(
      expect.objectContaining({ activeTaskId: null }),
    );
    await closeSocket(secondSocket);
  });

  it('serializes cancellation with natural failure and records only one terminal outcome', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);

    const first = await createTask();
    const firstAssignment = await claimTask(socket, first.id);
    sendAccepted(socket, first.id, firstAssignment.payload.leaseToken);
    await waitForTaskStatus(first.id, BuildTaskStatus.PREPARING);
    const firstCancelMessage = waitForMessage(socket, 'task.cancel');
    const firstCancel = await request(app.getHttpServer())
      .post('/api/tasks/' + first.id + '/cancel')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});
    expect(firstCancel.status).toBe(200);
    await firstCancelMessage;
    sendTaskFailure(
      socket,
      first.id,
      firstAssignment.payload.leaseToken,
      'COMMAND_FAILED: natural failure',
    );
    await waitForTaskStatus(first.id, BuildTaskStatus.FAILED);
    const firstHistory = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: first.id },
      select: { fromStatus: true, toStatus: true },
    });
    expect(taskTransitions(firstHistory)).toEqual(
      expect.arrayContaining(['PREPARING->CANCELING', 'CANCELING->FAILED']),
    );
    expect(
      firstHistory.filter(
        (item) =>
          item.toStatus === BuildTaskStatus.FAILED || item.toStatus === BuildTaskStatus.CANCELED,
      ),
    ).toHaveLength(1);

    const second = await createTask();
    const secondAssignment = await claimTask(socket, second.id);
    sendAccepted(socket, second.id, secondAssignment.payload.leaseToken);
    await waitForTaskStatus(second.id, BuildTaskStatus.PREPARING);
    sendTaskFailure(
      socket,
      second.id,
      secondAssignment.payload.leaseToken,
      'COMMAND_FAILED: natural failure first',
    );
    await waitForTaskStatus(second.id, BuildTaskStatus.FAILED);
    const cancelAfterFailure = await request(app.getHttpServer())
      .post('/api/tasks/' + second.id + '/cancel')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});
    expect(cancelAfterFailure.status).toBe(409);
    expect(cancelAfterFailure.body.code).toBe('TASK_INVALID_STATE');
    const secondHistory = await prisma.buildTaskStatusHistory.findMany({
      where: { taskId: second.id },
      select: { fromStatus: true, toStatus: true },
    });
    expect(taskTransitions(secondHistory)).not.toContain('FAILED->CANCELING');
    await closeSocket(socket);
  });

  it('reclaims a cancellation when the Agent does not confirm before timeout', async () => {
    const task = await createTask();
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const cancelMessage = waitForMessage(socket, 'task.cancel');
    const cancel = await request(app.getHttpServer())
      .post('/api/tasks/' + task.id + '/cancel')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});
    expect(cancel.status).toBe(200);
    await cancelMessage;

    const future = new Date(Date.now() + 31_000);
    await queue.reclaimTimedOutCancellations(future);
    await waitForTaskStatus(task.id, BuildTaskStatus.FAILED);
    const stored = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.leaseHash).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toEqual(
      expect.objectContaining({ activeTaskId: null, status: AgentStatus.OFFLINE }),
    );
    expect(app.get(AgentConnectionRegistry).isReady(agentId)).toBe(false);
    const historyCount = await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } });
    await queue.reclaimTimedOutCancellations(new Date(future.getTime() + 31_000));
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      historyCount,
    );

    const waitingTask = await createTask();
    expect(waitingTask.status).toBe(BuildTaskStatus.WAITING_AGENT);
    expect(app.get(AgentConnectionRegistry).isReady(agentId)).toBe(false);

    const reconnected = openSocket();
    await waitForOpen(reconnected);
    const available = waitForMessage(reconnected, 'task.available');
    await sendHello(reconnected);
    await available;
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toEqual(
      expect.objectContaining({ status: AgentStatus.ONLINE, activeTaskId: null }),
    );
    expect(await prisma.buildTask.findUniqueOrThrow({ where: { id: waitingTask.id } })).toEqual(
      expect.objectContaining({ status: BuildTaskStatus.QUEUED }),
    );
    const reassigned = await claimTask(reconnected, waitingTask.id);
    expect(reassigned.payload.taskId).toBe(waitingTask.id);
    await closeSocket(reconnected);
    await closeSocket(socket);
  });

  it('reclaims a cancellation when task.cancel cannot be sent', async () => {
    const task = await createTask();
    const socket = openSocket();
    await waitForOpen(socket);
    const available = waitForMessage(socket, 'task.available');
    await sendHello(socket);
    await available;
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const send = jest.spyOn(app.get(AgentConnectionRegistry), 'send').mockReturnValue(false);
    try {
      const cancel = await request(app.getHttpServer())
        .post('/api/tasks/' + task.id + '/cancel')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({});
      expect(cancel.status).toBe(200);
      expect(cancel.body.task.status).toBe('CANCELING');
      await queue.reclaimTimedOutCancellations(new Date(Date.now() + 31_000));
      await waitForTaskStatus(task.id, BuildTaskStatus.FAILED);
    } finally {
      send.mockRestore();
    }
    await closeSocket(socket);
  });

  it('reclaims a cancellation when the in-memory lease token is missing', async () => {
    const task = await createTask();
    const socket = openSocket();
    await waitForOpen(socket);
    const available = waitForMessage(socket, 'task.available');
    await sendHello(socket);
    await available;
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);

    const activeLeaseTokens = Reflect.get(queue, 'activeLeaseTokens') as Map<string, string>;
    expect(activeLeaseTokens.delete(task.id)).toBe(true);
    const cancel = await request(app.getHttpServer())
      .post('/api/tasks/' + task.id + '/cancel')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body.task.status).toBe('CANCELING');

    await queue.reclaimTimedOutCancellations(new Date(Date.now() + 31_000));
    await waitForTaskStatus(task.id, BuildTaskStatus.FAILED);
    const stored = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.leaseHash).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    await closeSocket(socket);
  });

  it('uploads artifacts over HTTP and completes the task over WebSocket', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    sendTaskStatus(
      socket,
      task.id,
      assignment.payload.leaseToken,
      'RUNNING',
      '0123456789abcdef0123456789abcdef01234567',
    );
    await waitForTaskStatus(task.id, BuildTaskStatus.RUNNING);
    sendTaskStatus(
      socket,
      task.id,
      assignment.payload.leaseToken,
      'UPLOADING',
      '0123456789abcdef0123456789abcdef01234567',
    );
    await waitForTaskStatus(task.id, BuildTaskStatus.UPLOADING);

    const content = Buffer.from('websocket artifact\n', 'utf8');
    const manifestAck = waitForMessage(socket, 'task.artifact-manifest-ack');
    sendArtifactManifest(socket, task.id, assignment.payload.leaseToken, content);
    await expect(manifestAck).resolves.toMatchObject({
      payload: { accepted: true, artifactCount: 1, artifactBytes: content.length },
    });
    const uploaded = await request(app.getHttpServer())
      .put(`/api/agent/tasks/${task.id}/artifacts/content`)
      .query({ relativePath: 'nested/app.txt' })
      .set('Authorization', `Bearer ${assignment.payload.leaseToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);
    expect(uploaded.status).toBe(200);

    sendTaskCompleted(socket, task.id, assignment.payload.leaseToken, content.length);
    await waitForTaskStatus(task.id, BuildTaskStatus.SUCCEEDED);
    const stored = await prisma.artifact.findFirstOrThrow({ where: { taskId: task.id } });
    expect(stored.uploadedAt).not.toBeNull();
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      null,
    );
    await closeSocket(socket);
  });

  it('matches the manifest against the artifactDir captured at dispatch time', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    const assignment = await claimTask(socket, task.id);
    expect(assignment.payload.artifactDir).toBe('dist');
    expect(
      (await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).assignedArtifactDir,
    ).toBe('dist');
    await prisma.buildTemplate.update({
      where: { id: templateId },
      data: { artifactDir: 'release' },
    });

    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    sendTaskStatus(
      socket,
      task.id,
      assignment.payload.leaseToken,
      'RUNNING',
      '0123456789abcdef0123456789abcdef01234567',
    );
    await waitForTaskStatus(task.id, BuildTaskStatus.RUNNING);
    sendTaskStatus(
      socket,
      task.id,
      assignment.payload.leaseToken,
      'UPLOADING',
      '0123456789abcdef0123456789abcdef01234567',
    );
    await waitForTaskStatus(task.id, BuildTaskStatus.UPLOADING);
    const content = Buffer.from('dispatch artifactDir', 'utf8');
    const manifestAck = waitForMessage(socket, 'task.artifact-manifest-ack');
    sendArtifactManifest(socket, task.id, assignment.payload.leaseToken, content);
    await expect(manifestAck).resolves.toMatchObject({ payload: { accepted: true } });
    const uploaded = await request(app.getHttpServer())
      .put(`/api/agent/tasks/${task.id}/artifacts/content`)
      .query({ relativePath: 'nested/app.txt' })
      .set('Authorization', `Bearer ${assignment.payload.leaseToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);
    expect(uploaded.status).toBe(200);
    sendTaskCompleted(socket, task.id, assignment.payload.leaseToken, content.length);
    await waitForTaskStatus(task.id, BuildTaskStatus.SUCCEEDED);
    await closeSocket(socket);
  });

  it('closes a connection when task.completed is rejected and releases the task', async () => {
    const socket = openSocket();
    await waitForOpen(socket);
    await sendHello(socket);
    const task = await createTask();
    const assignment = await claimTask(socket, task.id);
    sendAccepted(socket, task.id, assignment.payload.leaseToken);
    await waitForTaskStatus(task.id, BuildTaskStatus.PREPARING);
    sendTaskStatus(
      socket,
      task.id,
      assignment.payload.leaseToken,
      'RUNNING',
      '0123456789abcdef0123456789abcdef01234567',
    );
    await waitForTaskStatus(task.id, BuildTaskStatus.RUNNING);
    sendTaskStatus(
      socket,
      task.id,
      assignment.payload.leaseToken,
      'UPLOADING',
      '0123456789abcdef0123456789abcdef01234567',
    );
    await waitForTaskStatus(task.id, BuildTaskStatus.UPLOADING);

    const content = Buffer.from('rejected completion artifact\n', 'utf8');
    const manifestAck = waitForMessage(socket, 'task.artifact-manifest-ack');
    sendArtifactManifest(socket, task.id, assignment.payload.leaseToken, content);
    await expect(manifestAck).resolves.toMatchObject({ payload: { accepted: true } });
    const uploaded = await request(app.getHttpServer())
      .put(`/api/agent/tasks/${task.id}/artifacts/content`)
      .query({ relativePath: 'nested/app.txt' })
      .set('Authorization', `Bearer ${assignment.payload.leaseToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);
    expect(uploaded.status).toBe(200);

    const closed = waitForClose(socket);
    sendTaskCompleted(socket, task.id, assignment.payload.leaseToken, content.length + 1);
    await closed;
    await waitForTaskStatus(task.id, BuildTaskStatus.FAILED);
    const failed = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(failed.leaseHash).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      null,
    );
    expect(app.get(AgentConnectionRegistry).isReady(agentId)).toBe(false);

    const followUp = await createTask();
    expect(followUp.status).toBe(BuildTaskStatus.WAITING_AGENT);
    const offlineMessages = await collectMessages(socket, 'task.assignment', 100);
    expect(offlineMessages).toHaveLength(0);

    const reconnected = openSocket();
    await waitForOpen(reconnected);
    const available = waitForMessage(reconnected, 'task.available');
    await sendHello(reconnected);
    await expect(available).resolves.toMatchObject({ type: 'task.available' });
    const nextAssignment = await claimTask(reconnected, followUp.id);
    expect(nextAssignment.payload.taskId).toBe(followUp.id);
    await closeSocket(reconnected);
  });
});
