import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AgentStatus, BuildTaskStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import WebSocket from 'ws';

import { AppModule } from '../../src/app.module';
import { PasswordService } from '../../src/auth/password.service';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PrismaService } from '../../src/database/prisma.service';
import { AgentTokenService } from '../../src/agents/agent-token.service';
import { TaskLogStorageService } from '../../src/task-logs/task-log-storage.service';
import { TaskLogsService } from '../../src/task-logs/task-logs.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Task log integration tests require buildplatform_test');
}

jest.setTimeout(30_000);

describe('T5.1 task logs PostgreSQL/file/WebSocket integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  let logRoot: string;
  let adminToken: string;
  let adminId: string;
  let userToken: string;
  let agentId: string;
  let agentToken: string;
  let taskId: string;
  let otherTaskId: string;

  async function resetDatabase(): Promise<void> {
    await prisma.agent.updateMany({ data: { activeTaskId: null } });
    await prisma.artifact.deleteMany();
    await prisma.buildTaskStatusHistory.deleteMany();
    await prisma.buildTask.deleteMany();
    await prisma.project.deleteMany();
    await prisma.buildTemplate.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  }

  async function waitForOpen(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', reject);
    });
  }

  async function waitForType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timeout: ' + type)), 5_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type !== type) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(message);
      };
      socket.on('message', onMessage);
    });
  }

  async function closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) socket.close();
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
    });
  }

  async function login(
    username = 'logs-admin',
    password = 'Logs admin password 🔐',
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username, password });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  function sendHello(socket: WebSocket): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'agent.hello',
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        payload: {
          agentId,
          agentVersion: '5.1-test',
          hostname: 'log-host',
          os: 'linux',
          arch: 'x86_64',
          workspaceRoot: 'C:/agent-workspace',
          currentTask: null,
        },
      }),
    );
  }

  function sendLog(socket: WebSocket, leaseToken: string, sequence: number, chunk: string): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.log',
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        payload: {
          taskId,
          leaseToken,
          sequence,
          stream: 'stdout',
          chunk,
          emittedAt: new Date().toISOString(),
        },
      }),
    );
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    logRoot = await mkdtemp(join(tmpdir(), 'buildplatform-task-logs-'));
    process.env.TASK_LOG_ROOT = logRoot;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    prisma = app.get(PrismaService);
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    const [admin, otherUser] = await Promise.all([
      prisma.user.create({
        data: {
          username: 'logs-admin',
          passwordHash: await passwords.hash('Logs admin password 🔐'),
          role: UserRole.ADMIN,
        },
      }),
      prisma.user.create({
        data: {
          username: 'logs-user',
          passwordHash: await passwords.hash('Logs user password 🔐'),
        },
      }),
    ]);
    adminId = admin.id;
    const tokenService = new AgentTokenService(prisma);
    agentToken = tokenService.generateToken();
    const agent = await prisma.agent.create({
      data: {
        name: 'logs-agent-' + randomUUID(),
        tokenHash: tokenService.hashToken(agentToken),
        status: AgentStatus.OFFLINE,
        enabled: true,
      },
    });
    agentId = agent.id;
    const template = await prisma.buildTemplate.create({
      data: {
        name: 'logs-template-' + randomUUID(),
        createdBy: adminId,
        agentId,
        gitUrl: 'https://example.invalid/logs.git',
        command: 'echo build',
        artifactDir: 'dist',
        formSchema: [
          { name: 'password', label: 'Password', type: 'password', sensitive: true },
          { name: 'safe', label: 'Safe', type: 'input' },
        ],
        timeoutSeconds: 60,
      },
    });
    const project = await prisma.project.create({
      data: {
        ownerId: adminId,
        buildTemplateId: template.id,
        name: 'logs-project',
        branch: 'main',
        config: { password: 'server-secret-value', safe: 'safe-value' },
      },
    });
    const task = await prisma.buildTask.create({
      data: {
        projectId: project.id,
        buildTemplateId: template.id,
        agentId,
        createdBy: adminId,
        status: BuildTaskStatus.QUEUED,
        branch: 'main',
        config: { password: 'server-secret-value', safe: 'safe-value' },
        queuedAt: new Date(),
      },
    });
    taskId = task.id;
    const otherProject = await prisma.project.create({
      data: {
        ownerId: otherUser.id,
        buildTemplateId: template.id,
        name: 'other-logs-project',
        branch: 'main',
        config: { password: 'other-secret', safe: 'other-safe' },
      },
    });
    const otherTask = await prisma.buildTask.create({
      data: {
        projectId: otherProject.id,
        buildTemplateId: template.id,
        agentId,
        createdBy: otherUser.id,
        status: BuildTaskStatus.CREATED,
        branch: 'main',
        config: { password: 'other-secret', safe: 'other-safe' },
      },
    });
    otherTaskId = otherTask.id;
    app.get(LoginRateLimiterService).reset();
    adminToken = await login();
    userToken = await login('logs-user', 'Logs user password 🔐');
  });

  afterAll(async () => {
    await app.close();
    await rm(logRoot, { recursive: true, force: true });
  });

  it('persists ordered logs, returns idempotent ACKs, masks sensitive values, and streams history/live data', async () => {
    const agentSocket = new WebSocket('ws://127.0.0.1:' + port + '/ws/agent', {
      headers: { Authorization: 'Bearer ' + agentToken },
    });
    await waitForOpen(agentSocket);
    const registered = waitForType(agentSocket, 'agent.registered');
    sendHello(agentSocket);
    await registered;
    await waitForType(agentSocket, 'task.available');

    const claim = waitForType(agentSocket, 'task.assignment');
    agentSocket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.claim',
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        payload: { agentId, taskId: null },
      }),
    );
    const assignment = await claim;
    const leaseToken = (assignment.payload as Record<string, unknown>).leaseToken as string;

    const ack1 = waitForType(agentSocket, 'task.log.ack');
    sendLog(agentSocket, leaseToken, 1, 'safe-value server-secret-value');
    const firstAck = await ack1;
    expect((firstAck.payload as Record<string, unknown>).acknowledgedSequence).toBe(1);
    expect((firstAck.payload as Record<string, unknown>).persistedOffset).toBeGreaterThan(0);

    const duplicateAck = waitForType(agentSocket, 'task.log.ack');
    sendLog(agentSocket, leaseToken, 1, 'safe-value server-secret-value');
    expect((await duplicateAck).payload).toEqual(firstAck.payload);

    const gapAck = waitForType(agentSocket, 'task.log.ack');
    sendLog(agentSocket, leaseToken, 3, 'gap');
    expect((await gapAck).payload).toEqual(firstAck.payload);

    const ack2 = waitForType(agentSocket, 'task.log.ack');
    sendLog(agentSocket, leaseToken, 2, 'second');
    await ack2;

    const history = await request(app.getHttpServer())
      .get('/api/tasks/' + taskId + '/logs?offset=0&limit=65536')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(history.status).toBe(200);
    expect(history.body.entries).toHaveLength(2);
    expect(JSON.stringify(history.body)).not.toContain('server-secret-value');
    expect(history.body.entries[0].chunk).toContain('[REDACTED]');
    expect(history.body.nextOffset).toBe(history.body.size);

    for (let sequence = 3; sequence <= 20; sequence += 1) {
      const ack = waitForType(agentSocket, 'task.log.ack');
      sendLog(agentSocket, leaseToken, sequence, 'large-log-' + 'x'.repeat(60_000));
      await ack;
    }

    const browser = new WebSocket('ws://127.0.0.1:' + port + '/ws/client');
    await waitForOpen(browser);
    const authOk = waitForType(browser, 'auth.ok');
    browser.send(JSON.stringify({ type: 'auth', accessToken: adminToken }));
    await authOk;
    const historical = new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const messages: Record<string, unknown>[] = [];
      const timer = setTimeout(() => reject(new Error('historical log replay timeout')), 10_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type !== 'task.log') return;
        messages.push(message);
        const entry = message.entry as Record<string, unknown>;
        if (entry.sequence !== 21) return;
        clearTimeout(timer);
        browser.off('message', onMessage);
        resolve(messages);
      };
      browser.on('message', onMessage);
    });
    const logs = app.get(TaskLogsService);
    const readHistory = logs.readHistory.bind(logs);
    const readHistorySpy = jest
      .spyOn(logs, 'readHistory')
      .mockImplementation(async (actor, id, currentOffset, limit) => {
        const result = await readHistory(actor, id, currentOffset, limit);
        if (currentOffset > 0) await new Promise((resolve) => setTimeout(resolve, 50));
        return result;
      });
    browser.send(JSON.stringify({ type: 'task.log.subscribe', taskId, offset: 0 }));
    const liveAck = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        const ack = waitForType(agentSocket, 'task.log.ack');
        sendLog(agentSocket, leaseToken, 21, 'live-safe');
        void ack.then(() => resolve()).catch(reject);
      }, 10);
    });
    const pushed = await historical;
    await liveAck;
    readHistorySpy.mockRestore();
    expect(pushed).toHaveLength(21);
    expect(pushed.map((message) => (message.entry as Record<string, unknown>).sequence)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
    let replayOffset = 0;
    for (const message of pushed) {
      expect(message.taskId).toBe(taskId);
      expect(message.offset).toBe(replayOffset);
      expect(JSON.stringify(message)).not.toContain('server-secret-value');
      replayOffset = message.nextOffset as number;
    }
    expect(replayOffset).toBeGreaterThan(1_048_576);
    expect(pushed[pushed.length - 1].taskId).toBe(taskId);
    expect((pushed[pushed.length - 1].entry as Record<string, unknown>).chunk).toBe('live-safe');

    await closeSocket(browser);
    await closeSocket(agentSocket);
  });

  it('does not persist lease tokens or log content in PostgreSQL', async () => {
    const task = await prisma.buildTask.findUniqueOrThrow({
      where: { id: taskId },
      select: { logSize: true, lastLogSequence: true, config: true },
    });
    expect(task.logSize).toBe(0n);
    expect(task.lastLogSequence).toBe(0n);
    expect(Object.keys(task)).not.toEqual(
      expect.arrayContaining(['leaseHash', 'logLeaseHash', 'tokenHash']),
    );
  });

  it('aligns database log metadata to the synced file cursor in either direction', async () => {
    const storage = app.get(TaskLogStorageService);
    const agentSocket = new WebSocket('ws://127.0.0.1:' + port + '/ws/agent', {
      headers: { Authorization: 'Bearer ' + agentToken },
    });
    await waitForOpen(agentSocket);
    const registered = waitForType(agentSocket, 'agent.registered');
    sendHello(agentSocket);
    await registered;
    await waitForType(agentSocket, 'task.available');

    const claim = waitForType(agentSocket, 'task.assignment');
    agentSocket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'task.claim',
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        payload: { agentId, taskId: null },
      }),
    );
    const assignment = await claim;
    const leaseToken = (assignment.payload as Record<string, unknown>).leaseToken as string;

    await prisma.buildTask.update({
      where: { id: taskId },
      data: { lastLogSequence: 99n, logSize: 999n },
    });
    const firstAck = waitForType(agentSocket, 'task.log.ack');
    sendLog(agentSocket, leaseToken, 1, 'first');
    await firstAck;
    const afterFirst = await prisma.buildTask.findUniqueOrThrow({
      where: { id: taskId },
      select: { lastLogSequence: true, logSize: true },
    });
    expect(afterFirst.lastLogSequence).toBe(1n);
    expect(afterFirst.logSize).toBeGreaterThan(0n);

    await storage.append(taskId, {
      sequence: 2,
      stream: 'stdout',
      chunk: 'file-only',
      emittedAt: new Date().toISOString(),
    });
    const thirdAck = waitForType(agentSocket, 'task.log.ack');
    sendLog(agentSocket, leaseToken, 3, 'third');
    expect((await thirdAck).payload).toMatchObject({ acknowledgedSequence: 3 });
    const afterThird = await prisma.buildTask.findUniqueOrThrow({
      where: { id: taskId },
      select: { lastLogSequence: true, logSize: true },
    });
    expect(afterThird.lastLogSequence).toBe(3n);
    expect(afterThird.logSize).toBeGreaterThan(afterFirst.logSize);

    await closeSocket(agentSocket);
  });

  it('enforces task-log ownership and hides cross-user task existence', async () => {
    const crossUser = await request(app.getHttpServer())
      .get('/api/tasks/' + taskId + '/logs')
      .set('Authorization', 'Bearer ' + userToken);
    expect(crossUser.status).toBe(404);
    expect(crossUser.body.code).toBe('RESOURCE_NOT_FOUND');

    const own = await request(app.getHttpServer())
      .get('/api/tasks/' + otherTaskId + '/logs')
      .set('Authorization', 'Bearer ' + userToken);
    expect(own.status).toBe(200);
    expect(own.body.entries).toEqual([]);
  });
});
