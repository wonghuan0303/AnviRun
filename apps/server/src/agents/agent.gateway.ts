import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import {
  AGENT_HEARTBEAT_INTERVAL_SECONDS,
  AGENT_HEARTBEAT_TIMEOUT_SECONDS,
  PROTOCOL_VERSION,
  validateProtocolMessage,
} from '@anvilrun/contracts';
import type {
  AgentHeartbeatMessage,
  AgentHelloMessage,
  AgentRegisteredMessage,
  AgentTokenRevokedMessage,
  ServerToAgentMessage,
  TaskAcceptedMessage,
  TaskCanceledMessage,
  TaskClaimMessage,
  TaskArtifactManifestMessage,
  TaskCompletedMessage,
  TaskFailedMessage,
  TaskLogMessage,
  TaskStatusMessage,
  TaskRecoveryMessage,
  TaskResultAckMessage,
  TaskInputAckMessage,
} from '@anvilrun/contracts';
import { AgentStatus, BuildTaskStatus } from '@prisma/client';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/api-exception';
import { AgentConnectionRegistry } from './agent-connection.registry';
import { AgentTokenService, type AuthenticatedAgent } from './agent-token.service';
import { TaskQueueService } from '../tasks/task-queue.service';
import { TaskLogsService } from '../task-logs/task-logs.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { MAX_AGENT_WS_MESSAGE_BYTES } from '../common/security-limits';

interface ConnectionState {
  readonly agentId: string;
  helloReceived: boolean;
  lastHeartbeatAt: number;
  messageQueue: Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_CONNECTION_TASK_STATUSES = [
  BuildTaskStatus.DISPATCHED,
  BuildTaskStatus.PREPARING,
  BuildTaskStatus.RUNNING,
  BuildTaskStatus.UPLOADING,
  BuildTaskStatus.CANCELING,
  BuildTaskStatus.AGENT_LOST,
] as const;

function bearerToken(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token || undefined;
}

function messageText(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw)).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason.slice(0, 120));
    } else if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  } catch {
    socket.terminate();
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function plainTextWithin(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !hasControlCharacters(value);
}

function registeredMessage(agentId: string, agentName: string): AgentRegisteredMessage {
  return {
    id: randomUUID(),
    type: 'agent.registered',
    timestamp: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    payload: {
      agentId,
      agentName,
      heartbeatIntervalSeconds: AGENT_HEARTBEAT_INTERVAL_SECONDS,
      heartbeatTimeoutSeconds: AGENT_HEARTBEAT_TIMEOUT_SECONDS,
      serverTime: new Date().toISOString(),
    },
  };
}

function revokedMessage(agentId: string, reason: string): AgentTokenRevokedMessage {
  return {
    id: randomUUID(),
    type: 'agent.token.revoked',
    timestamp: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    payload: {
      agentId,
      revokedAt: new Date().toISOString(),
      reason,
    },
  };
}

function recoveryMessage(
  decision: import('../tasks/task-queue.service').AgentRecoveryDecision,
): TaskRecoveryMessage {
  return {
    id: randomUUID(),
    type: 'task.recovery',
    timestamp: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    payload: {
      taskId: decision.taskId,
      action: decision.action,
      acknowledgedLogSequence: decision.acknowledgedLogSequence,
      ...(decision.status === undefined ? {} : { status: decision.status }),
      ...(decision.recoveryDeadlineAt === undefined
        ? {}
        : { recoveryDeadlineAt: decision.recoveryDeadlineAt }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    },
  };
}

function resultAckMessage(
  taskId: string,
  status: TaskResultAckMessage['payload']['status'],
): TaskResultAckMessage {
  return {
    id: randomUUID(),
    type: 'task.result.ack',
    timestamp: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    payload: { taskId, status, acknowledgedAt: new Date().toISOString() },
  };
}

@Injectable()
export class AgentGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_AGENT_WS_MESSAGE_BYTES,
  });
  private readonly states = new Map<WebSocket, ConnectionState>();
  private httpServer?: HttpServer;
  private upgradeHandler?: (request: IncomingMessage, socket: Socket, head: Buffer) => void;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly prisma: PrismaService,
    private readonly tokens: AgentTokenService,
    private readonly registry: AgentConnectionRegistry,
    private readonly moduleRef: ModuleRef,
    private readonly logs: TaskLogsService,
  ) {}

  onApplicationBootstrap(): void {
    this.httpServer = this.httpAdapterHost.httpAdapter.getHttpServer() as HttpServer;
    this.upgradeHandler = (request, socket, head) => {
      if (!this.isAgentPath(request)) return;
      void this.handleUpgrade(request, socket, head).catch(() => this.rejectUpgrade(socket));
    };
    this.httpServer.on('upgrade', this.upgradeHandler);
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), 1_000);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.httpServer && this.upgradeHandler) this.httpServer.off('upgrade', this.upgradeHandler);
    for (const [, socket] of this.registry.entries()) {
      this.closeAndForget(socket, 1001, 'server shutting down');
    }
    this.websocketServer.close();
  }

  isConnected(agentId: string): boolean {
    return this.registry.isConnected(agentId);
  }

  async revokeConnection(
    agentId: string,
    reason: 'disabled' | 'rotation' | 'deleted',
    options: { markOffline?: boolean } = {},
  ): Promise<void> {
    const socket = this.registry.get(agentId);
    if (socket) {
      this.registry.unregister(agentId, socket);
      this.states.delete(socket);
    }
    if (options.markOffline !== false) await this.markOffline(agentId);
    await this.taskQueue()?.onAgentDisconnected(agentId);
    if (!socket) return;

    try {
      if (socket.readyState !== WebSocket.OPEN) {
        safeClose(socket, 1008, 'token revoked');
        return;
      }
      socket.send(JSON.stringify(revokedMessage(agentId, reason)), () => {
        safeClose(socket, 1008, 'token revoked');
      });
    } catch {
      safeClose(socket, 1008, 'token revoked');
    }
  }

  async sweep(now = new Date()): Promise<void> {
    const timeoutMs = AGENT_HEARTBEAT_TIMEOUT_SECONDS * 1_000;
    for (const [agentId, socket] of this.registry.entries()) {
      const state = this.states.get(socket);
      if (!state || now.getTime() - state.lastHeartbeatAt < timeoutMs) continue;
      this.registry.unregister(agentId, socket);
      this.states.delete(socket);
      await this.markOffline(agentId);
      await this.taskQueue()?.onAgentDisconnected(agentId);
      safeClose(socket, 1001, 'heartbeat timeout');
    }
  }

  private isAgentPath(request: IncomingMessage): boolean {
    try {
      return new URL(request.url ?? '/', 'http://localhost').pathname === '/ws/agent';
    } catch {
      return false;
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const agent = await this.tokens.authenticateToken(bearerToken(request.headers.authorization));
    if (!agent || socket.destroyed) {
      this.rejectUpgrade(socket);
      return;
    }
    const initialized = await this.prisma.agent.updateMany({
      where: { id: agent.id, enabled: true },
      data: { status: AgentStatus.OFFLINE },
    });
    if (initialized.count !== 1 || socket.destroyed) {
      this.rejectUpgrade(socket);
      return;
    }

    this.websocketServer.handleUpgrade(request, socket, head, (client) => {
      this.accept(agent, client);
    });
  }

  private rejectUpgrade(socket: Socket): void {
    if (socket.destroyed) return;
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }

  private accept(agent: AuthenticatedAgent, socket: WebSocket): void {
    const previous = this.registry.register(agent.id, socket);
    if (previous && previous !== socket) {
      this.states.delete(previous);
      safeClose(previous, 1000, 'replaced by a newer connection');
    }
    const state: ConnectionState = {
      agentId: agent.id,
      helloReceived: false,
      lastHeartbeatAt: Date.now(),
      messageQueue: Promise.resolve(),
    };
    this.states.set(socket, state);
    socket.on('message', (raw) => {
      const next = state.messageQueue
        .then(async () => {
          // A replacement connection owns the Agent row as soon as it is
          // registered. Do not let messages already queued on the old socket
          // mutate that new connection's task state.
          if (this.states.get(socket) !== state) return;
          await this.handleMessage(socket, raw, state);
        })
        .catch(() => {
          if (this.states.get(socket) === state) {
            safeClose(socket, 1011, 'message processing failed');
          }
        });
      state.messageQueue = next;
    });
    socket.on('close', () => void this.handleClose(socket, state.agentId).catch(() => undefined));
    socket.on('error', () => undefined);
  }

  private async handleMessage(
    socket: WebSocket,
    raw: RawData,
    expectedState: ConnectionState,
  ): Promise<void> {
    const state = this.states.get(socket);
    if (!state || state !== expectedState) return;
    let input: unknown;
    try {
      input = JSON.parse(messageText(raw)) as unknown;
    } catch {
      safeClose(socket, 1008, 'invalid protocol message');
      return;
    }
    const result = validateProtocolMessage(input);
    if (!result.ok) {
      safeClose(socket, 1008, 'invalid protocol message');
      return;
    }
    try {
      if (result.value.type === 'agent.hello') {
        await this.handleHello(socket, state, result.value as AgentHelloMessage);
      } else if (result.value.type === 'agent.heartbeat') {
        await this.handleHeartbeat(socket, state, result.value as AgentHeartbeatMessage);
      } else if (result.value.type === 'task.claim') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        const queue = this.taskQueue();
        if (!queue) return;
        try {
          const assignment = await queue.claim(
            state.agentId,
            (result.value as TaskClaimMessage).id,
            (result.value as TaskClaimMessage).payload.taskId,
          );
          if (assignment) this.send(socket, assignment);
        } catch (error) {
          if (!(error instanceof ApiException)) throw error;
        }
      } else if (result.value.type === 'task.accepted') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        const queue = this.taskQueue();
        if (!queue) return;
        try {
          const accepted = result.value as TaskAcceptedMessage;
          await queue.accept(state.agentId, accepted.payload.taskId, accepted.payload.leaseToken);
        } catch (error) {
          if (!(error instanceof ApiException)) throw error;
        }
      } else if (result.value.type === 'task.status') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        const queue = this.taskQueue();
        if (!queue) return;
        try {
          await queue.reportTaskStatus(state.agentId, result.value as TaskStatusMessage);
        } catch (error) {
          if (!(error instanceof ApiException)) throw error;
        }
      } else if (result.value.type === 'task.log') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        try {
          const ack = await this.logs.appendFromAgent(
            state.agentId,
            result.value as TaskLogMessage,
          );
          this.send(socket, ack);
        } catch (error) {
          if (!(error instanceof ApiException)) throw error;
        }
      } else if (result.value.type === 'task.artifact-manifest') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        const artifacts = this.artifactsService();
        if (!artifacts) return;
        try {
          const ack = await artifacts.registerManifest(
            state.agentId,
            result.value as TaskArtifactManifestMessage,
          );
          this.send(socket, ack);
        } catch (error) {
          if (error instanceof ApiException) {
            this.send(socket, artifacts.manifestRejectedAck(result.value.payload.taskId));
          } else {
            throw error;
          }
        }
      } else if (result.value.type === 'task.completed') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        const artifacts = this.artifactsService();
        if (!artifacts) return;
        try {
          const completed = await artifacts.completeTask(
            state.agentId,
            result.value as TaskCompletedMessage,
          );
          await this.taskQueue()?.onTaskCompleted(state.agentId, completed.taskId);
          this.send(socket, resultAckMessage(completed.taskId, 'SUCCEEDED'));
          await this.taskQueue()?.onAgentReady(state.agentId);
        } catch (error) {
          if (error instanceof ApiException) {
            await this.taskQueue()?.failRejectedCompletion(
              state.agentId,
              result.value as TaskCompletedMessage,
            );
            safeClose(socket, 1011, 'task completion rejected');
            return;
          }
          throw error;
        }
      } else if (result.value.type === 'task.failed') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        const queue = this.taskQueue();
        if (!queue) return;
        try {
          const failed = await queue.reportPreparationFailure(
            state.agentId,
            result.value as TaskFailedMessage,
          );
          this.send(socket, resultAckMessage(result.value.payload.taskId, failed));
          await queue.onAgentReady(state.agentId);
        } catch (error) {
          if (error instanceof ApiException) {
            // Invalid/stale failure reports must not turn a still-valid
            // execution lease into a disconnect. A matching report can still
            // arrive; the lease/recovery scanners handle an absent report.
            return;
          }
          throw error;
        }
      } else if (result.value.type === 'task.canceled') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        const queue = this.taskQueue();
        if (!queue) return;
        try {
          const canceled = await queue.reportTaskCanceled(
            state.agentId,
            result.value as TaskCanceledMessage,
          );
          this.send(socket, resultAckMessage(result.value.payload.taskId, canceled));
          await queue.onAgentReady(state.agentId);
        } catch (error) {
          if (error instanceof ApiException) {
            // A stale or malformed cancellation confirmation must not tear
            // down the live lease. The Agent can still deliver the valid
            // confirmation, and the normal cancellation timeout remains the
            // recovery path if it never does.
            return;
          }
          throw error;
        }
      } else if (result.value.type === 'task.input.ack') {
        if (!state.helloReceived) {
          safeClose(socket, 1008, 'hello required');
          return;
        }
        this.taskQueue()?.handleTaskInputAck(state.agentId, result.value as TaskInputAckMessage);
      } else {
        safeClose(socket, 1008, 'unsupported protocol message');
      }
    } catch {
      safeClose(socket, 1011, 'message processing failed');
    }
  }

  private async handleHello(
    socket: WebSocket,
    state: ConnectionState,
    message: AgentHelloMessage,
  ): Promise<void> {
    const payload = message.payload;
    if (
      payload.agentId !== undefined &&
      payload.agentId !== null &&
      payload.agentId !== state.agentId
    ) {
      await this.rejectConnection(socket, state.agentId, 'agent identity mismatch');
      return;
    }
    if (
      !plainTextWithin(payload.agentVersion, 64) ||
      !plainTextWithin(payload.hostname, 255) ||
      !plainTextWithin(payload.os, 64) ||
      !plainTextWithin(payload.arch, 64)
    ) {
      safeClose(socket, 1008, 'invalid agent metadata');
      return;
    }
    const agent = await this.prisma.agent.findFirst({
      where: { id: state.agentId, enabled: true },
      select: { name: true },
    });
    if (!agent) {
      await this.rejectConnection(socket, state.agentId, 'agent disabled');
      return;
    }
    const queue = this.taskQueue();
    if (!queue) {
      safeClose(socket, 1011, 'task recovery service unavailable');
      return;
    }
    const capabilities = payload.capabilities ?? [];
    const recovery = await queue.reconcileAgentHello(
      state.agentId,
      payload.currentTask,
      capabilities,
    );
    const updated = await this.prisma.agent.updateMany({
      where: { id: state.agentId, enabled: true },
      data: {
        hostname: payload.hostname,
        os: payload.os,
        arch: payload.arch,
        version: payload.agentVersion,
        lastSeenAt: new Date(),
        status: AgentStatus.ONLINE,
        activeTaskId:
          recovery?.action === 'RESUME' || recovery?.action === 'CANCEL' ? recovery.taskId : null,
      },
    });
    if (updated.count !== 1) {
      await this.rejectConnection(socket, state.agentId, 'agent disabled');
      return;
    }
    state.helloReceived = true;
    state.lastHeartbeatAt = Date.now();
    this.registry.markReady(state.agentId, socket, capabilities);
    this.send(socket, registeredMessage(state.agentId, agent.name));
    if (recovery) this.send(socket, recoveryMessage(recovery));
    await queue.onAgentReady(state.agentId);
  }

  private async handleHeartbeat(
    socket: WebSocket,
    state: ConnectionState,
    message: AgentHeartbeatMessage,
  ): Promise<void> {
    if (!state.helloReceived || message.payload.agentId !== state.agentId) {
      await this.rejectConnection(socket, state.agentId, 'agent identity mismatch');
      return;
    }
    const activeTaskId = await this.validHeartbeatTask(
      state.agentId,
      message.payload.currentTaskId,
    );
    const updated = await this.prisma.agent.updateMany({
      where: { id: state.agentId, enabled: true },
      data: {
        lastSeenAt: new Date(),
        status: AgentStatus.ONLINE,
        ...(activeTaskId ? { activeTaskId } : {}),
      },
    });
    if (updated.count !== 1) {
      await this.rejectConnection(socket, state.agentId, 'agent disabled');
      return;
    }
    state.lastHeartbeatAt = Date.now();
  }

  private async validHeartbeatTask(agentId: string, taskId: string | null): Promise<string | null> {
    if (!taskId || !UUID_PATTERN.test(taskId)) return null;
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { activeTaskId: true },
    });
    if (agent?.activeTaskId !== taskId) return null;
    const task = await this.prisma.buildTask.findFirst({
      where: { id: taskId, agentId, status: { in: [...ACTIVE_CONNECTION_TASK_STATUSES] } },
      select: { id: true },
    });
    return task?.id ?? null;
  }

  private send(socket: WebSocket, message: ServerToAgentMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      safeClose(socket, 1011, 'message delivery failed');
    }
  }

  private taskQueue(): TaskQueueService | undefined {
    try {
      return this.moduleRef.get(TaskQueueService, { strict: false });
    } catch {
      return undefined;
    }
  }

  private artifactsService(): ArtifactsService | undefined {
    try {
      return this.moduleRef.get(ArtifactsService, { strict: false });
    } catch {
      return undefined;
    }
  }

  private async rejectConnection(
    socket: WebSocket,
    agentId: string,
    reason: string,
  ): Promise<void> {
    const owned = this.registry.unregister(agentId, socket);
    this.states.delete(socket);
    if (owned) {
      await this.markOffline(agentId);
      await this.taskQueue()?.onAgentDisconnected(agentId);
    }
    safeClose(socket, 1008, reason);
  }

  private async handleClose(socket: WebSocket, agentId: string): Promise<void> {
    const owned = this.registry.unregister(agentId, socket);
    this.states.delete(socket);
    if (owned) {
      await this.markOffline(agentId);
      await this.taskQueue()?.onAgentDisconnected(agentId);
    }
  }

  private closeAndForget(socket: WebSocket, code: number, reason: string): void {
    for (const [agentId, current] of this.registry.entries()) {
      if (current === socket) this.registry.unregister(agentId, socket);
    }
    this.states.delete(socket);
    safeClose(socket, code, reason);
  }

  private async markOffline(agentId: string): Promise<void> {
    await this.prisma.agent.updateMany({
      where: { id: agentId, enabled: true },
      data: { status: AgentStatus.OFFLINE },
    });
  }
}
