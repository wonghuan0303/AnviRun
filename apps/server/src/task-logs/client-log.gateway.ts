import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import { UserStatus } from '@prisma/client';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { TokenService } from '../auth/token.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PrismaService } from '../database/prisma.service';
import { TaskLogsService, type TaskLogBroadcastEvent } from './task-logs.service';
import { MAX_CLIENT_WS_MESSAGE_BYTES } from '../common/security-limits';
import { TaskInputService, type TaskInputErrorCode } from '../tasks/task-input.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_SUBSCRIPTIONS = 8;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

function inputErrorMessage(code: TaskInputErrorCode): string {
  const messages: Record<TaskInputErrorCode, string> = {
    TASK_INPUT_NOT_ENABLED: '该任务未启用交互输入',
    TASK_INPUT_NOT_RUNNING: '任务当前不在运行状态',
    TASK_INPUT_AGENT_UNSUPPORTED: '当前 Agent 不支持交互输入',
    TASK_INPUT_AGENT_OFFLINE: '当前 Agent 离线',
    TASK_INPUT_BUSY: '任务输入控制台正被其他窗口占用',
    TASK_INPUT_NOT_CONTROLLER: '请先获取任务输入控制权',
    TASK_INPUT_INVALID: '输入格式无效',
    TASK_INPUT_TOO_LARGE: '输入内容过长',
    TASK_INPUT_RATE_LIMITED: '发送过于频繁，请稍后再试',
    TASK_INPUT_STDIN_CLOSED: '任务输入通道已关闭',
    TASK_INPUT_DELIVERY_TIMEOUT: '输入发送超时',
    TASK_INPUT_DELIVERY_FAILED: '输入发送失败',
  };
  return messages[code];
}

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
  private readonly websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_WS_MESSAGE_BYTES,
  });
  private readonly states = new Map<WebSocket, ClientState>();
  private httpServer?: HttpServer;
  private removeTaskInputStateListener?: () => void;
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
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    this.httpServer = this.httpAdapterHost.httpAdapter.getHttpServer() as HttpServer;
    this.upgradeHandler = (request, socket, head) => {
      if (!this.isClientPath(request)) return;
      this.websocketServer.handleUpgrade(request, socket, head, (client) => this.accept(client));
    };
    this.httpServer.on('upgrade', this.upgradeHandler);
    this.removeTaskInputStateListener = this.taskInput()?.onStateChange((taskId) => {
      this.broadcastTaskInputState(taskId);
    });
  }

  onModuleDestroy(): void {
    this.removeTaskInputStateListener?.();
    this.removeTaskInputStateListener = undefined;
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
      this.taskInput()?.releaseTask(socket, message.taskId);
      return;
    }
    if (message.type === 'task.input.acquire') {
      await this.acquireInput(socket, state, message);
      return;
    }
    if (message.type === 'task.input.send') {
      await this.sendInput(socket, state, message);
      return;
    }
    if (message.type === 'task.input.release') {
      await this.releaseInput(socket, state, message);
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
      await this.sendInputState(socket, state, message.taskId);
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

  private async acquireInput(
    socket: WebSocket,
    state: ClientState,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (typeof message.taskId !== 'string') {
      this.sendInputState(socket, state, '', 'TASK_INPUT_INVALID');
      return;
    }
    const service = this.taskInput();
    if (!service) return;
    try {
      const inputState = await service.acquire(state.actor!, socket, message.taskId);
      this.send(socket, {
        type: 'task.input.state',
        ...inputState,
        requestId: safeRequestId(message.requestId),
      });
    } catch {
      this.sendInputState(socket, state, message.taskId, 'TASK_INPUT_INVALID', message.requestId);
    }
  }

  private async sendInput(
    socket: WebSocket,
    state: ClientState,
    message: Record<string, unknown>,
  ): Promise<void> {
    const taskId = message.taskId;
    const inputId = message.inputId;
    const text = message.text;
    const sensitive = message.sensitive;
    if (
      typeof taskId !== 'string' ||
      typeof inputId !== 'string' ||
      typeof text !== 'string' ||
      typeof sensitive !== 'boolean'
    ) {
      this.send(socket, {
        type: 'task.input.result',
        taskId: typeof taskId === 'string' ? taskId : '',
        inputId: typeof inputId === 'string' ? inputId : '',
        status: 'REJECTED',
        code: 'TASK_INPUT_INVALID',
        message: '输入格式无效',
      });
      return;
    }
    const service = this.taskInput();
    if (!service) {
      this.sendInputResult(socket, taskId, inputId, 'TASK_INPUT_DELIVERY_FAILED');
      return;
    }
    try {
      const outcome = await service.send(state.actor!, socket, taskId, inputId, text, sensitive);
      this.send(socket, { type: 'task.input.state', ...outcome.state });
      this.send(socket, {
        type: 'task.input.result',
        taskId,
        inputId,
        status: outcome.result.status,
        ...(outcome.result.code
          ? { code: outcome.result.code, message: inputErrorMessage(outcome.result.code) }
          : {}),
      });
    } catch {
      try {
        const inputState = await service.getState(state.actor!, socket, taskId);
        this.send(socket, { type: 'task.input.state', ...inputState });
      } catch {
        // If the state lookup also fails, leave the last known state intact.
        // The result below still clears the client's in-flight operation.
      }
      this.sendInputResult(socket, taskId, inputId, 'TASK_INPUT_DELIVERY_FAILED');
    }
  }

  private async releaseInput(
    socket: WebSocket,
    state: ClientState,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (typeof message.taskId !== 'string') return;
    const service = this.taskInput();
    if (!service) return;
    try {
      const inputState = await service.release(state.actor!, socket, message.taskId);
      this.send(socket, {
        type: 'task.input.state',
        ...inputState,
        requestId: safeRequestId(message.requestId),
      });
    } catch {
      this.sendInputState(socket, state, message.taskId, 'TASK_INPUT_INVALID', message.requestId);
    }
  }

  private async sendInputState(
    socket: WebSocket,
    state: ClientState,
    taskId: string,
    overrideReason?: TaskInputErrorCode,
    requestId?: unknown,
  ): Promise<void> {
    if (!taskId) {
      this.send(socket, {
        type: 'task.input.state',
        taskId,
        enabled: false,
        writable: false,
        controlledByCurrentSocket: false,
        busy: false,
        reason: overrideReason ?? 'TASK_INPUT_INVALID',
        ...(safeRequestId(requestId) ? { requestId: safeRequestId(requestId) } : {}),
      });
      return;
    }
    const service = this.taskInput();
    if (!service) return;
    try {
      const inputState = await service.getState(state.actor!, socket, taskId);
      this.send(socket, {
        type: 'task.input.state',
        ...inputState,
        ...(overrideReason ? { reason: overrideReason, writable: false } : {}),
        ...(safeRequestId(requestId) ? { requestId: safeRequestId(requestId) } : {}),
      });
    } catch {
      this.send(socket, {
        type: 'task.input.state',
        taskId,
        enabled: false,
        writable: false,
        controlledByCurrentSocket: false,
        busy: false,
        reason: overrideReason ?? 'TASK_INPUT_INVALID',
      });
    }
  }

  private taskInput(): TaskInputService | undefined {
    try {
      return this.moduleRef.get(TaskInputService, { strict: false });
    } catch {
      return undefined;
    }
  }

  private sendInputResult(
    socket: WebSocket,
    taskId: string,
    inputId: string,
    code: TaskInputErrorCode,
  ): void {
    this.send(socket, {
      type: 'task.input.result',
      taskId,
      inputId,
      status: 'REJECTED',
      code,
      message: inputErrorMessage(code),
    });
  }

  private broadcastTaskInputState(taskId: string): void {
    const service = this.taskInput();
    if (!service) return;
    for (const [socket, state] of this.states) {
      if (!state.actor || !state.subscriptions.has(taskId)) continue;
      void service
        .getState(state.actor, socket, taskId)
        .then((inputState) => {
          this.send(socket, { type: 'task.input.state', ...inputState });
        })
        .catch(() => {
          this.send(socket, {
            type: 'task.input.state',
            taskId,
            enabled: false,
            writable: false,
            controlledByCurrentSocket: false,
            busy: false,
            reason: 'TASK_INPUT_INVALID',
          });
        });
    }
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
    this.taskInput()?.releaseSocket(socket);
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
