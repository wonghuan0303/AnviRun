import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AgentStatus, UserRole } from '@prisma/client';
import { AGENT_HEARTBEAT_TIMEOUT_SECONDS, PROTOCOL_VERSION } from '@anvilrun/contracts';
import request from 'supertest';
import WebSocket from 'ws';

import { AppModule } from '../../src/app.module';
import { AgentGateway } from '../../src/agents/agent.gateway';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PasswordService } from '../../src/auth/password.service';
import { PrismaService } from '../../src/database/prisma.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Agent WebSocket integration tests require buildplatform_test');
}

type ProtocolMessage = { type: string; payload: Record<string, unknown> };

describe('T2.1 native Agent WebSocket PostgreSQL integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gateway: AgentGateway;
  let port: number;
  let adminToken: string;

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

  async function login(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'ws-admin', password: 'WS admin password 🔐' });
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

  function openSocket(token: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function waitForOpen(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 3_000);
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

  async function waitForClose(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function waitForMessage(socket: WebSocket, type: string): Promise<ProtocolMessage> {
    return new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`message timeout: ${type}`)), 3_000);
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

  async function cannotConnect(token: string): Promise<void> {
    const socket = openSocket(token);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('invalid token connected'));
      }, 3_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.once('open', () => finish(new Error('invalid token connected')));
      socket.once('error', () => finish());
      socket.once('close', () => finish());
    });
  }

  async function sendHello(socket: WebSocket, agentId?: string | null): Promise<ProtocolMessage> {
    const registered = waitForMessage(socket, 'agent.registered');
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'agent.hello',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: {
          ...(agentId === undefined ? {} : { agentId }),
          agentVersion: '2.1.0-test',
          hostname: 'test-host',
          os: 'linux',
          arch: 'x86_64',
          workspaceRoot: 'C:/agent-workspace',
        },
      }),
    );
    return registered;
  }

  function sendHeartbeat(socket: WebSocket, agentId: string): void {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        type: 'agent.heartbeat',
        timestamp: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        payload: { agentId, currentTaskId: null },
      }),
    );
  }

  async function closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) socket.close();
    await waitForClose(socket);
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    prisma = app.get(PrismaService);
    gateway = app.get(AgentGateway);
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    await prisma.user.create({
      data: {
        username: 'ws-admin',
        passwordHash: await passwords.hash('WS admin password 🔐'),
        role: UserRole.ADMIN,
      },
    });
    app.get(LoginRateLimiterService).reset();
    adminToken = await login();
  });

  afterAll(async () => {
    await app.close();
  });

  it('authenticates by header, accepts hello/heartbeat, and rejects identity mismatch', async () => {
    const agent = await createAgent('hello-agent');
    await cannotConnect(`${agent.token}-invalid`);
    const other = await createAgent('other-agent');
    const mismatched = openSocket(agent.token);
    await waitForOpen(mismatched);
    const noRegistration = sendHello(mismatched, other.id);
    await expect(noRegistration).rejects.toThrow('message timeout');
    await waitForClose(mismatched);

    const socket = openSocket(agent.token);
    await waitForOpen(socket);
    const registered = await sendHello(socket);
    expect(registered.payload).toEqual(
      expect.objectContaining({
        agentId: agent.id,
        agentName: 'hello-agent',
        heartbeatIntervalSeconds: 15,
        heartbeatTimeoutSeconds: 45,
      }),
    );
    const online = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(online).toEqual(
      expect.objectContaining({
        status: AgentStatus.ONLINE,
        hostname: 'test-host',
        os: 'linux',
        arch: 'x86_64',
        version: '2.1.0-test',
      }),
    );
    const lastSeen = online?.lastSeenAt?.getTime() ?? 0;
    sendHeartbeat(socket, agent.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (await prisma.agent.findUnique({ where: { id: agent.id } }))?.lastSeenAt?.getTime(),
    ).toBeGreaterThanOrEqual(lastSeen);
    await closeSocket(socket);

    const heartbeatSocket = openSocket(agent.token);
    await waitForOpen(heartbeatSocket);
    await sendHello(heartbeatSocket, agent.id);
    sendHeartbeat(heartbeatSocket, other.id);
    await waitForClose(heartbeatSocket);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe(
      AgentStatus.OFFLINE,
    );
  });

  it('initializes Agent OFFLINE before exposing the WebSocket', async () => {
    const agent = await createAgent('ordered-init-agent');
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const originalUpdateMany = prisma.agent.updateMany.bind(prisma.agent);
    const updateManySpy = jest.spyOn(prisma.agent, 'updateMany');
    updateManySpy.mockImplementation((args) => {
      const where = args.where as { id?: string; enabled?: boolean };
      const data = args.data as { status?: AgentStatus };
      if (where.id === agent.id && where.enabled === true && data.status === AgentStatus.OFFLINE) {
        return (async () => {
          await initializationGate;
          return originalUpdateMany(args);
        })() as ReturnType<typeof prisma.agent.updateMany>;
      }
      return originalUpdateMany(args);
    });

    const socket = openSocket(agent.token);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(socket.readyState).not.toBe(WebSocket.OPEN);
      releaseInitialization();
      await waitForOpen(socket);
      await sendHello(socket, agent.id);
      expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe(
        AgentStatus.ONLINE,
      );
    } finally {
      releaseInitialization();
      if (socket.readyState === WebSocket.OPEN) {
        await closeSocket(socket);
      } else if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
        await waitForClose(socket);
      }
      updateManySpy.mockRestore();
    }
  });

  it('revokes connected sockets on rotate/disable and makes old tokens unusable', async () => {
    const agent = await createAgent('revocation-agent');
    const socket = openSocket(agent.token);
    await waitForOpen(socket);
    await sendHello(socket, null);
    const revoked = waitForMessage(socket, 'agent.token.revoked');
    const rotated = await request(app.getHttpServer())
      .post(`/api/admin/agents/${agent.id}/token/rotate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(rotated.status).toBe(200);
    expect((await revoked).payload).toEqual(
      expect.objectContaining({ agentId: agent.id, reason: 'rotation' }),
    );
    await waitForClose(socket);
    await cannotConnect(agent.token);

    const newToken = rotated.body.registrationToken as string;
    const newSocket = openSocket(newToken);
    await waitForOpen(newSocket);
    await sendHello(newSocket, agent.id);
    const disabledMessage = waitForMessage(newSocket, 'agent.token.revoked');
    const disabled = await request(app.getHttpServer())
      .post(`/api/admin/agents/${agent.id}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(disabled.status).toBe(200);
    expect((await disabledMessage).payload).toEqual(
      expect.objectContaining({ agentId: agent.id, reason: 'disabled' }),
    );
    await waitForClose(newSocket);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe(
      AgentStatus.DISABLED,
    );
    await cannotConnect(newToken);
  });

  it('replaces old connections without stale close callbacks and sweeps heartbeat timeouts', async () => {
    const agent = await createAgent('lifecycle-agent');
    await request(app.getHttpServer())
      .post(`/api/admin/agents/${agent.id}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const enabled = await request(app.getHttpServer())
      .post(`/api/admin/agents/${agent.id}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(enabled.body.agent.status).toBe('OFFLINE');

    const first = openSocket(agent.token);
    await waitForOpen(first);
    await sendHello(first, agent.id);
    const second = openSocket(agent.token);
    await waitForOpen(second);
    await sendHello(second, agent.id);
    await waitForClose(first);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe(
      AgentStatus.ONLINE,
    );

    await gateway.sweep(new Date(Date.now() + AGENT_HEARTBEAT_TIMEOUT_SECONDS * 1_000 + 1));
    await waitForClose(second);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe(
      AgentStatus.OFFLINE,
    );
  });
});
