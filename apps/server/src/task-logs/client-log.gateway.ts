import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { UserStatus } from '@prisma/client';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { TokenService } from '../auth/token.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PrismaService } from '../database/prisma.service';
import { TaskLogsService, type TaskLogBroadcastEvent } from './task-logs.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_SUBSCRIPTIONS = 8;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

interface ClientSubscription {
  readonly taskId: string;
  readonly unsubscribe: () => void;
}

interface ClientState {
  actor?: AuthenticatedRequestUser;
  authTimer: NodeJS.Timeout;
  readonly subscriptions: Map<string, ClientSubscription>;
}

/** 面向浏览器的任务日志订阅协议；不复用 Agent 注册令牌。 */
@Injectable()
export class ClientLogGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly states = new Map<WebSocket, ClientState>();
  private httpServer?: HttpServer;
  private upgradeHandler?: (
    request: IncomingMessage,
    socket: import('node:net').Socket,
    head: Buffer,
  ) => void;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly logs: TaskLogsService,
  ) {}

  onApplicationBootstrap(): void {
    this.httpServer = this.httpAdapterHost.httpAdapter.getHttpServer() as HttpServer;
    this.upgradeHandler = (request, socket, head) => {
      if (!this.isClientPath(request)) return;
      this.websocketServer.handleUpgrade(request, socket, head, (client) => this.accept(client));
    };
    this.httpServer.on('upgrade', this.upgradeHandler);
  }

  onModuleDestroy(): void {
    if (this.httpServer && this.upgradeHandler) this.httpServer.off('upgrade', this.upgradeHandler);
    for (const [socket, state] of this.states) {
      clearTimeout(state.authTimer);
      this.clearSubscriptions(state);
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        socket.terminate();
      }
    }
    this.states.clear();
    this.websocketServer.close();
  }

  private accept(socket: WebSocket): void {
    const authTimer = setTimeout(() => {
      if (!this.states.get(socket)?.actor) this.close(socket, 1008, 'authentication required');
    }, AUTH_TIMEOUT_MS);
    const state: ClientState = { authTimer, subscriptions: new Map() };
    this.states.set(socket, state);
    socket.on('message', (raw) => void this.handleMessage(socket, raw));
    socket.on('close', () => this.remove(socket));
    socket.on('error', () => this.remove(socket));
  }

  private async handleMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const state = this.states.get(socket);
    if (!state) return;
    let message: unknown;
    try {
      message = JSON.parse(this.messageText(raw)) as unknown;
    } catch {
      this.close(socket, 1008, 'invalid client message');
      return;
    }
    if (!this.isObject(message) || typeof message.type !== 'string') {
      this.close(socket, 1008, 'invalid client message');
      return;
    }
    if (!state.actor) {
      if (
        message.type !== 'auth' ||
        typeof message.accessToken !== 'string' ||
        message.accessToken.length === 0
      ) {
        this.close(socket, 1008, 'authentication required');
        return;
      }
      const actor = await this.authenticate(message.accessToken);
      if (!actor) {
        this.close(socket, 1008, 'authentication failed');
        return;
      }
      clearTimeout(state.authTimer);
      state.actor = actor;
      this.send(socket, { type: 'auth.ok' });
      return;
    }

    if (message.type === 'task.log.subscribe') {
      await this.subscribe(socket, state, message);
      return;
    }
    if (message.type === 'task.log.unsubscribe') {
      if (typeof message.taskId !== 'string') {
        this.close(socket, 1008, 'invalid task id');
        return;
      }
      this.removeSubscription(state, message.taskId);
      return;
    }
    this.close(socket, 1008, 'unsupported client message');
  }

  private async subscribe(
    socket: WebSocket,
    state: ClientState,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (typeof message.taskId !== 'string' || !UUID_PATTERN.test(message.taskId)) {
      this.close(socket, 1008, 'subscription rejected');
      return;
    }
    const offset = message.offset === undefined ? 0 : message.offset;
    if (!Number.isSafeInteger(offset) || typeof offset !== 'number' || offset < 0) {
      this.close(socket, 1008, 'subscription rejected');
      return;
    }
    if (state.subscriptions.has(message.taskId)) this.removeSubscription(state, message.taskId);
    if (state.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      this.close(socket, 1008, 'too many subscriptions');
      return;
    }

    try {
      await this.authorization.assertTaskLogAccess(state.actor!, message.taskId);
    } catch {
      this.close(socket, 1008, 'subscription rejected');
      return;
    }

    const queued: TaskLogBroadcastEvent[] = [];
    let reading = true;
    const unsubscribe = this.logs.subscribe(message.taskId, (event) => {
      if (reading) queued.push(event);
      else this.sendEvent(socket, event);
    });
    state.subscriptions.set(message.taskId, { taskId: message.taskId, unsubscribe });
    try {
      const firstPage = await this.logs.readHistory(
        state.actor!,
        message.taskId,
        offset,
        1_048_576,
      );
      const targetOffset = firstPage.size;
      let cursor = firstPage.offset;
      let page = firstPage;
      while (cursor < targetOffset) {
        for (const entry of page.entries) {
          if (cursor >= targetOffset) break;
          const nextOffset = cursor + Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
          this.sendEvent(socket, {
            taskId: message.taskId,
            offset: cursor,
            nextOffset,
            entry,
          });
          cursor = nextOffset;
        }
        if (cursor >= targetOffset) break;
        const nextPage = await this.logs.readHistory(
          state.actor!,
          message.taskId,
          cursor,
          1_048_576,
        );
        if (nextPage.entries.length === 0 || nextPage.nextOffset <= cursor) {
          throw new Error('log history did not advance');
        }
        page = nextPage;
      }
      reading = false;
      for (const event of queued) {
        if (event.offset >= cursor && event.nextOffset > cursor) {
          this.sendEvent(socket, event);
          cursor = event.nextOffset;
        }
      }
    } catch {
      this.removeSubscription(state, message.taskId);
      this.close(socket, 1008, 'subscription rejected');
    }
  }

  private async authenticate(accessToken: string): Promise<AuthenticatedRequestUser | undefined> {
    try {
      const claims = this.tokens.verifyAccessToken(accessToken);
      const user = await this.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, username: true, role: true, status: true, tokenVersion: true },
      });
      if (!user || user.status === UserStatus.DISABLED || user.tokenVersion !== claims.tokenVersion)
        return undefined;
      return { ...user, jti: claims.jti };
    } catch {
      return undefined;
    }
  }

  private sendEvent(socket: WebSocket, event: TaskLogBroadcastEvent): void {
    this.send(socket, {
      type: 'task.log',
      taskId: event.taskId,
      offset: event.offset,
      nextOffset: event.nextOffset,
      entry: event.entry,
    });
  }

  private send(socket: WebSocket, value: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(socket, 1009, 'client is too slow');
      return;
    }
    try {
      socket.send(JSON.stringify(value));
    } catch {
      this.close(socket, 1011, 'message delivery failed');
    }
  }

  private removeSubscription(state: ClientState, taskId: string): void {
    const subscription = state.subscriptions.get(taskId);
    if (!subscription) return;
    subscription.unsubscribe();
    state.subscriptions.delete(taskId);
  }

  private clearSubscriptions(state: ClientState): void {
    for (const subscription of state.subscriptions.values()) subscription.unsubscribe();
    state.subscriptions.clear();
  }

  private remove(socket: WebSocket): void {
    const state = this.states.get(socket);
    if (!state) return;
    clearTimeout(state.authTimer);
    this.clearSubscriptions(state);
    this.states.delete(socket);
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    this.remove(socket);
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(code, reason);
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    } catch {
      socket.terminate();
    }
  }

  private isClientPath(request: IncomingMessage): boolean {
    try {
      return new URL(request.url ?? '/', 'http://localhost').pathname === '/ws/client';
    } catch {
      return false;
    }
  }

  private messageText(raw: RawData): string {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw)).toString('utf8');
    return Buffer.from(raw).toString('utf8');
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
