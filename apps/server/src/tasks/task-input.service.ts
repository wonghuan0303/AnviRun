import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AgentStatus, BuildTaskStatus } from '@prisma/client';
import { utf8ByteLength } from '@anvilrun/contracts';
import { WebSocket } from 'ws';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { AuthorizationService } from '../authorization/authorization.service';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { AgentConnectionRegistry } from '../agents/agent-connection.registry';
import {
  TASK_INPUT_CAPABILITY,
  TaskQueueService,
  type TaskInputDeliveryCode,
  type TaskInputDeliveryResult,
} from './task-queue.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INPUT_BYTES = 4_096;
const CONTROL_IDLE_TIMEOUT_MS = 5 * 60_000;
const MIN_INPUT_INTERVAL_MS = 250;

export type TaskInputErrorCode =
  | 'TASK_INPUT_NOT_ENABLED'
  | 'TASK_INPUT_NOT_RUNNING'
  | 'TASK_INPUT_AGENT_UNSUPPORTED'
  | 'TASK_INPUT_AGENT_OFFLINE'
  | 'TASK_INPUT_BUSY'
  | 'TASK_INPUT_NOT_CONTROLLER'
  | 'TASK_INPUT_INVALID'
  | 'TASK_INPUT_TOO_LARGE'
  | 'TASK_INPUT_RATE_LIMITED'
  | 'TASK_INPUT_STDIN_CLOSED'
  | 'TASK_INPUT_DELIVERY_TIMEOUT'
  | 'TASK_INPUT_DELIVERY_FAILED';

export interface TaskInputState {
  readonly taskId: string;
  readonly enabled: boolean;
  readonly writable: boolean;
  readonly controlledByCurrentSocket: boolean;
  readonly busy: boolean;
  readonly reason?: TaskInputErrorCode;
}

export interface TaskInputOperationResult {
  readonly result: {
    readonly status: 'DELIVERED' | 'REJECTED';
    readonly code?: TaskInputErrorCode;
  };
  readonly state: TaskInputState;
}

export type TaskInputStateChangeListener = (taskId: string) => void;

interface Controller {
  readonly socket: WebSocket;
  readonly actorId: string;
  lastActivityAt: number;
  lastSentAt: number;
  busy: boolean;
  expiryTimer?: NodeJS.Timeout;
}

interface TaskInputContext {
  readonly id: string;
  readonly interactiveInputEnabled: boolean;
  readonly status: BuildTaskStatus;
  readonly agentId: string;
  readonly agentEnabled: boolean;
  readonly agentStatus: AgentStatus;
  readonly activeTaskId: string | null;
}

function hasForbiddenControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

function safeDeliveryCode(code: TaskInputDeliveryCode | undefined): TaskInputErrorCode | undefined {
  if (!code) return undefined;
  const knownCodes: ReadonlySet<TaskInputErrorCode> = new Set([
    'TASK_INPUT_NOT_ENABLED',
    'TASK_INPUT_NOT_RUNNING',
    'TASK_INPUT_AGENT_UNSUPPORTED',
    'TASK_INPUT_AGENT_OFFLINE',
    'TASK_INPUT_STDIN_CLOSED',
    'TASK_INPUT_DELIVERY_TIMEOUT',
    'TASK_INPUT_DELIVERY_FAILED',
  ]);
  return knownCodes.has(code) ? code : 'TASK_INPUT_DELIVERY_FAILED';
}

@Injectable()
export class TaskInputService implements OnModuleDestroy {
  private readonly controllers = new Map<string, Controller>();
  private readonly stdinClosedTasks = new Set<string>();
  private readonly stateChangeListeners = new Set<TaskInputStateChangeListener>();
  private readonly unsubscribeTaskTerminal: () => void;

  onStateChange(listener: TaskInputStateChangeListener): () => void {
    this.stateChangeListeners.add(listener);
    return () => this.stateChangeListeners.delete(listener);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly registry: AgentConnectionRegistry,
    private readonly queue: TaskQueueService,
    private readonly audit: AuditService,
  ) {
    this.unsubscribeTaskTerminal = this.queue.onTaskTerminal((taskId) =>
      this.clearTaskState(taskId),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribeTaskTerminal();
    for (const controller of this.controllers.values()) {
      if (controller.expiryTimer) clearTimeout(controller.expiryTimer);
      controller.expiryTimer = undefined;
    }
    this.controllers.clear();
    this.stdinClosedTasks.clear();
    this.stateChangeListeners.clear();
  }

  /**
   * Clears all in-memory input state for a task after its lifecycle ends.
   * This is intentionally independent of any browser connection or query.
   */
  clearTaskState(taskId: string): void {
    const hadClosedMarker = this.stdinClosedTasks.delete(taskId);
    const controller = this.controllers.get(taskId);
    if (controller) {
      this.deleteController(taskId, controller);
    } else if (hadClosedMarker) {
      this.notifyStateChange(taskId);
    }
  }

  async getState(
    actor: AuthenticatedRequestUser,
    socket: WebSocket,
    taskId: string,
  ): Promise<TaskInputState> {
    const context = await this.getContext(actor, taskId);
    this.expireController(taskId);
    return this.stateFor(context, socket);
  }

  async acquire(
    actor: AuthenticatedRequestUser,
    socket: WebSocket,
    taskId: string,
  ): Promise<TaskInputState> {
    const context = await this.getContext(actor, taskId);
    this.expireController(taskId);
    let controller = this.controllers.get(taskId);
    if (!context.interactiveInputEnabled) {
      this.recordControlAudit(actor.id, taskId, 'TASK_INPUT_ACQUIRE_REJECTED', {
        errorCode: 'TASK_INPUT_NOT_ENABLED',
      });
      return this.stateFor(context, socket, 'TASK_INPUT_NOT_ENABLED');
    }
    if (controller && controller.socket !== socket) {
      this.recordControlAudit(actor.id, taskId, 'TASK_INPUT_ACQUIRE_REJECTED', {
        errorCode: 'TASK_INPUT_BUSY',
      });
      return this.stateFor(context, socket, 'TASK_INPUT_BUSY');
    }
    const eligibility = this.stateFor(context, socket);
    if (eligibility.reason && eligibility.reason !== 'TASK_INPUT_BUSY') {
      this.recordControlAudit(actor.id, taskId, 'TASK_INPUT_ACQUIRE_REJECTED', {
        errorCode: eligibility.reason,
      });
      return eligibility;
    }
    if (!controller) {
      controller = {
        socket,
        actorId: actor.id,
        lastActivityAt: Date.now(),
        lastSentAt: 0,
        busy: false,
      };
      this.controllers.set(taskId, controller);
      this.scheduleControllerExpiry(taskId, controller);
    } else {
      controller.lastActivityAt = Date.now();
      this.scheduleControllerExpiry(taskId, controller);
    }
    this.recordControlAudit(actor.id, taskId, 'TASK_INPUT_ACQUIRE');
    this.notifyStateChange(taskId);
    return this.stateFor(context, socket);
  }

  async release(
    actor: AuthenticatedRequestUser,
    socket: WebSocket,
    taskId: string,
  ): Promise<TaskInputState> {
    try {
      const context = await this.getContext(actor, taskId);
      this.expireController(taskId);
      const controller = this.controllers.get(taskId);
      if (controller?.socket === socket && controller.actorId === actor.id) {
        this.deleteController(taskId, controller);
        this.recordControlAudit(actor.id, taskId, 'TASK_INPUT_RELEASE');
      }
      return this.stateFor(context, socket);
    } catch {
      return {
        taskId,
        enabled: false,
        writable: false,
        controlledByCurrentSocket: false,
        busy: false,
        reason: 'TASK_INPUT_INVALID',
      };
    }
  }

  async send(
    actor: AuthenticatedRequestUser,
    socket: WebSocket,
    taskId: string,
    inputId: string,
    text: string,
    sensitive: boolean,
  ): Promise<TaskInputOperationResult> {
    if (!UUID_PATTERN.test(taskId) || !UUID_PATTERN.test(inputId))
      return this.rejectedState(actor, socket, taskId, 'TASK_INPUT_INVALID');
    if (typeof text !== 'string' || hasForbiddenControlCharacters(text))
      return this.rejectedState(actor, socket, taskId, 'TASK_INPUT_INVALID');
    if (utf8ByteLength(text) > MAX_INPUT_BYTES)
      return this.rejectedState(actor, socket, taskId, 'TASK_INPUT_TOO_LARGE');
    if (typeof sensitive !== 'boolean')
      return this.rejectedState(actor, socket, taskId, 'TASK_INPUT_INVALID');

    const context = await this.getContext(actor, taskId);
    this.expireController(taskId);
    if (this.stdinClosedTasks.has(taskId)) {
      const closedController = this.controllers.get(taskId);
      if (closedController) this.deleteController(taskId, closedController);
      return {
        result: { status: 'REJECTED', code: 'TASK_INPUT_STDIN_CLOSED' },
        state: this.stateFor(context, socket, 'TASK_INPUT_STDIN_CLOSED'),
      };
    }
    const controller = this.controllers.get(taskId);
    if (!controller || controller.socket !== socket || controller.actorId !== actor.id)
      return {
        result: { status: 'REJECTED', code: 'TASK_INPUT_NOT_CONTROLLER' },
        state: this.stateFor(context, socket, 'TASK_INPUT_NOT_CONTROLLER'),
      };
    if (controller.busy)
      return {
        result: { status: 'REJECTED', code: 'TASK_INPUT_BUSY' },
        state: this.stateFor(context, socket, 'TASK_INPUT_BUSY'),
      };
    if (Date.now() - controller.lastSentAt < MIN_INPUT_INTERVAL_MS)
      return {
        result: { status: 'REJECTED', code: 'TASK_INPUT_RATE_LIMITED' },
        // Rate limiting is a transient result, not a change to the task's
        // control state. Keep the current writable state so the client can
        // retry after the interval without reacquiring the controller.
        state: this.stateFor(context, socket),
      };

    const preflight = this.stateFor(context, socket);
    if (!preflight.enabled || !preflight.writable) {
      if (preflight.reason === 'TASK_INPUT_STDIN_CLOSED') {
        this.deleteController(taskId, controller);
        return {
          result: { status: 'REJECTED', code: preflight.reason },
          state: this.stateFor(context, socket, preflight.reason),
        };
      }
      return {
        result: { status: 'REJECTED', code: preflight.reason ?? 'TASK_INPUT_STDIN_CLOSED' },
        state: preflight,
      };
    }

    controller.busy = true;
    controller.lastActivityAt = Date.now();
    controller.lastSentAt = Date.now();
    this.scheduleControllerExpiry(taskId, controller);
    this.notifyStateChange(taskId);
    let result: TaskInputDeliveryResult;
    try {
      result = await this.queue.sendTaskInput(taskId, inputId, text, sensitive);
    } catch {
      result = { status: 'REJECTED', code: 'TASK_INPUT_DELIVERY_FAILED' };
    } finally {
      controller.busy = false;
      controller.lastActivityAt = Date.now();
      this.scheduleControllerExpiry(taskId, controller);
      this.notifyStateChange(taskId);
    }
    const code = safeDeliveryCode(result.code);
    if (code === 'TASK_INPUT_STDIN_CLOSED') {
      // The Agent has definitively closed stdin even if the database has not
      // observed the lifecycle transition yet. Remember only the task id so
      // subsequent state reads and acquire attempts remain closed.
      this.stdinClosedTasks.add(taskId);
      this.deleteController(taskId, controller);
    }
    try {
      await this.audit.record({
        actorId: actor.id,
        action: result.status === 'DELIVERED' ? 'TASK_INPUT_DELIVERED' : 'TASK_INPUT_REJECTED',
        resourceType: 'BuildTask',
        resourceId: taskId,
        metadata: {
          taskId,
          inputId,
          sensitive,
          byteLength: Buffer.byteLength(text, 'utf8'),
          ...(code ? { errorCode: code } : {}),
        },
      });
    } catch {
      // Audit persistence must never turn an already delivered stdin write
      // into a client-visible failure or cause the browser to retry it.
    }
    return {
      result: { status: result.status, ...(code ? { code } : {}) },
      // Delivery errors are operation results only. The state must continue
      // to describe the actual controller/task/Agent state so transient
      // failures do not permanently disable the input panel.
      state: this.stateFor(context, socket, code === 'TASK_INPUT_STDIN_CLOSED' ? code : undefined),
    };
  }

  releaseSocket(socket: WebSocket): void {
    for (const [taskId, controller] of this.controllers) {
      if (controller.socket === socket) this.deleteController(taskId, controller);
    }
  }

  releaseTask(socket: WebSocket, taskId: string): void {
    const controller = this.controllers.get(taskId);
    if (controller?.socket === socket) this.deleteController(taskId, controller);
  }

  private async rejectedState(
    actor: AuthenticatedRequestUser,
    socket: WebSocket,
    taskId: string,
    code: TaskInputErrorCode,
  ): Promise<TaskInputOperationResult> {
    try {
      const context = await this.getContext(actor, taskId);
      return { result: { status: 'REJECTED', code }, state: this.stateFor(context, socket) };
    } catch {
      return {
        result: { status: 'REJECTED', code },
        state: {
          taskId,
          enabled: false,
          writable: false,
          controlledByCurrentSocket: false,
          busy: false,
          reason: code,
        },
      };
    }
  }

  private async getContext(
    actor: AuthenticatedRequestUser,
    taskId: string,
  ): Promise<TaskInputContext> {
    if (!UUID_PATTERN.test(taskId)) throw new Error('invalid task id');
    const task = await this.prisma.buildTask.findFirst({
      where: this.authorization.taskScope(actor, { id: taskId }),
      select: {
        id: true,
        interactiveInputEnabled: true,
        status: true,
        agentId: true,
        agent: { select: { enabled: true, status: true, activeTaskId: true } },
      },
    });
    if (!task) {
      throw new Error('task not found');
    }
    const context = {
      id: task.id,
      interactiveInputEnabled: task.interactiveInputEnabled,
      status: task.status,
      agentId: task.agentId,
      agentEnabled: task.agent.enabled,
      agentStatus: task.agent.status,
      activeTaskId: task.agent.activeTaskId,
    };
    if (context.status !== BuildTaskStatus.RUNNING) this.clearTaskState(context.id);
    return context;
  }

  private stateFor(
    context: TaskInputContext,
    socket: WebSocket,
    overrideReason?: TaskInputErrorCode,
  ): TaskInputState {
    const controller = this.controllers.get(context.id);
    const controlledByCurrentSocket = controller?.socket === socket;
    const busy = controller?.busy ?? false;
    let reason = overrideReason;
    if (!reason && !context.interactiveInputEnabled) reason = 'TASK_INPUT_NOT_ENABLED';
    else if (!reason && context.status !== BuildTaskStatus.RUNNING)
      reason = 'TASK_INPUT_NOT_RUNNING';
    else if (!reason && this.stdinClosedTasks.has(context.id)) reason = 'TASK_INPUT_STDIN_CLOSED';
    else if (
      !reason &&
      (!context.agentEnabled ||
        context.agentStatus !== AgentStatus.ONLINE ||
        !this.registry.isReady(context.agentId))
    )
      reason = 'TASK_INPUT_AGENT_OFFLINE';
    else if (!reason && !this.registry.hasCapability(context.agentId, TASK_INPUT_CAPABILITY))
      reason = 'TASK_INPUT_AGENT_UNSUPPORTED';
    else if (!reason && context.activeTaskId !== context.id) reason = 'TASK_INPUT_STDIN_CLOSED';
    else if (!reason && controller && !controlledByCurrentSocket) reason = 'TASK_INPUT_BUSY';
    else if (!reason && busy) reason = 'TASK_INPUT_BUSY';
    return {
      taskId: context.id,
      enabled: context.interactiveInputEnabled,
      writable: reason === undefined && controlledByCurrentSocket && !busy,
      controlledByCurrentSocket,
      busy,
      ...(reason ? { reason } : {}),
    };
  }

  private expireController(taskId: string): void {
    const controller = this.controllers.get(taskId);
    if (controller && Date.now() - controller.lastActivityAt >= CONTROL_IDLE_TIMEOUT_MS)
      this.deleteController(taskId, controller);
  }

  private scheduleControllerExpiry(taskId: string, controller: Controller): void {
    if (controller.expiryTimer) clearTimeout(controller.expiryTimer);
    const remaining = Math.max(
      1,
      CONTROL_IDLE_TIMEOUT_MS - (Date.now() - controller.lastActivityAt),
    );
    controller.expiryTimer = setTimeout(() => {
      const current = this.controllers.get(taskId);
      if (current !== controller) return;
      if (Date.now() - current.lastActivityAt >= CONTROL_IDLE_TIMEOUT_MS) {
        this.deleteController(taskId, current);
      } else {
        this.scheduleControllerExpiry(taskId, current);
      }
    }, remaining);
    controller.expiryTimer.unref?.();
  }

  private deleteController(taskId: string, controller: Controller): void {
    if (this.controllers.get(taskId) !== controller) return;
    if (controller.expiryTimer) clearTimeout(controller.expiryTimer);
    controller.expiryTimer = undefined;
    this.controllers.delete(taskId);
    this.notifyStateChange(taskId);
  }

  private notifyStateChange(taskId: string): void {
    for (const listener of this.stateChangeListeners) {
      try {
        listener(taskId);
      } catch {
        // A state observer must not interfere with input control or delivery.
      }
    }
  }

  private recordControlAudit(
    actorId: string,
    taskId: string,
    action: string,
    metadata?: Record<string, string | number | boolean | null>,
  ): void {
    void this.audit
      .record({
        actorId,
        action,
        resourceType: 'BuildTask',
        resourceId: taskId,
        metadata: { taskId, ...metadata },
      })
      .catch(() => undefined);
  }
}
