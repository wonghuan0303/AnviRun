import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  AGENT_HEARTBEAT_INTERVAL_SECONDS,
  AGENT_HEARTBEAT_TIMEOUT_SECONDS,
  PROTOCOL_VERSION,
  validateProtocolMessage,
} from '@buildplatform/contracts';
import type {
  AgentHeartbeatMessage,
  AgentHelloMessage,
  AgentRegisteredMessage,
  AgentTokenRevokedMessage,
} from '@buildplatform/contracts';
import { AgentStatus } from '@prisma/client';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import { PrismaService } from '../database/prisma.service';
import { AgentConnectionRegistry } from './agent-connection.registry';
import { AgentTokenService, type AuthenticatedAgent } from './agent-token.service';

interface ConnectionState {
  readonly agentId: string;
  helloReceived: boolean;
  lastHeartbeatAt: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

@Injectable()
export class AgentGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly states = new Map<WebSocket, ConnectionState>();
  private httpServer?: HttpServer;
  private upgradeHandler?: (request: IncomingMessage, socket: Socket, head: Buffer) => void;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly prisma: PrismaService,
    private readonly tokens: AgentTokenService,
    private readonly registry: AgentConnectionRegistry,
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
    };
    this.states.set(socket, state);
    socket.on('message', (raw) => void this.handleMessage(socket, raw));
    socket.on('close', () => void this.handleClose(socket, state.agentId).catch(() => undefined));
    socket.on('error', () => undefined);
  }

  private async handleMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const state = this.states.get(socket);
    if (!state) return;
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
    const activeTaskId = await this.validAgentTask(state.agentId, payload.currentTask?.taskId);
    const updated = await this.prisma.agent.updateMany({
      where: { id: state.agentId, enabled: true },
      data: {
        hostname: payload.hostname,
        os: payload.os,
        arch: payload.arch,
        version: payload.agentVersion,
        lastSeenAt: new Date(),
        status: AgentStatus.ONLINE,
        ...(activeTaskId ? { activeTaskId } : {}),
      },
    });
    if (updated.count !== 1) {
      await this.rejectConnection(socket, state.agentId, 'agent disabled');
      return;
    }
    state.helloReceived = true;
    state.lastHeartbeatAt = Date.now();
    this.send(socket, registeredMessage(state.agentId, agent.name));
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
    const activeTaskId = await this.validAgentTask(state.agentId, message.payload.currentTaskId);
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

  private async validAgentTask(
    agentId: string,
    taskId: string | null | undefined,
  ): Promise<string | null> {
    if (!taskId || !UUID_PATTERN.test(taskId)) return null;
    const task = await this.prisma.buildTask.findFirst({
      where: { id: taskId, agentId },
      select: { id: true },
    });
    return task?.id ?? null;
  }

  private send(
    socket: WebSocket,
    message: AgentRegisteredMessage | AgentTokenRevokedMessage,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      safeClose(socket, 1011, 'message delivery failed');
    }
  }

  private async rejectConnection(
    socket: WebSocket,
    agentId: string,
    reason: string,
  ): Promise<void> {
    const owned = this.registry.unregister(agentId, socket);
    this.states.delete(socket);
    if (owned) await this.markOffline(agentId);
    safeClose(socket, 1008, reason);
  }
  private async handleClose(socket: WebSocket, agentId: string): Promise<void> {
    const owned = this.registry.unregister(agentId, socket);
    this.states.delete(socket);
    if (owned) await this.markOffline(agentId);
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
