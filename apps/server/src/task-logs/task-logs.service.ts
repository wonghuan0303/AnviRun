import { Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BuildTaskStatus, Prisma } from '@prisma/client';
import {
  listSensitiveFormFieldNames,
  validateFormSchema,
  type LogStream,
  type TaskLogAckMessage,
  type TaskLogMessage,
} from '@buildplatform/contracts';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { AuthorizationService } from '../authorization/authorization.service';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../database/prisma.service';
import {
  MAX_TASK_LOG_CHUNK_BYTES,
  TaskLogStorageError,
  TaskLogStorageService,
  type TaskLogEntry,
  type TaskLogReadResult,
} from './task-log-storage.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set<BuildTaskStatus>([
  BuildTaskStatus.DISPATCHED,
  BuildTaskStatus.PREPARING,
  BuildTaskStatus.RUNNING,
  BuildTaskStatus.UPLOADING,
]);
const LOGGABLE_TERMINAL_STATUSES = new Set<BuildTaskStatus>([
  BuildTaskStatus.SUCCEEDED,
  BuildTaskStatus.FAILED,
  BuildTaskStatus.AGENT_LOST,
  BuildTaskStatus.CANCELED,
]);

const LOG_TASK_SELECT = {
  id: true,
  agentId: true,
  status: true,
  leaseHash: true,
  leaseExpiresAt: true,
  logLeaseHash: true,
  logLeaseExpiresAt: true,
  lastLogSequence: true,
  logSize: true,
  logSensitiveKeys: true,
  config: true,
  agent: { select: { activeTaskId: true } },
  buildTemplate: { select: { formSchema: true } },
} as const;

type LogTask = Prisma.BuildTaskGetPayload<{ select: typeof LOG_TASK_SELECT }>;

export interface TaskLogAck {
  readonly taskId: string;
  readonly acknowledgedSequence: number;
  readonly persistedOffset: number;
}

export interface TaskLogBroadcastEvent {
  readonly taskId: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly entry: TaskLogEntry;
}

type Subscriber = (event: TaskLogBroadcastEvent) => void;

/** 任务日志的授权、序号裁决、敏感值遮蔽和实时广播服务。 */
@Injectable()
export class TaskLogsService {
  private readonly taskLocks = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly redactors = new Map<string, ServerLogRedactor>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly storage: TaskLogStorageService,
  ) {}

  async appendFromAgent(agentId: string, message: TaskLogMessage): Promise<TaskLogAckMessage> {
    const payload = message.payload;
    if (
      !UUID_PATTERN.test(payload.taskId) ||
      Buffer.byteLength(payload.chunk, 'utf8') > MAX_TASK_LOG_CHUNK_BYTES
    ) {
      throw new ApiException('VALIDATION_FAILED');
    }

    return this.withTaskLock(payload.taskId, async () => {
      const task = await this.prisma.buildTask.findUnique({
        where: { id: payload.taskId },
        select: LOG_TASK_SELECT,
      });
      if (!task || task.agentId !== agentId) throw new ApiException('TASK_LEASE_INVALID');
      this.assertLogLease(task, payload.leaseToken);

      const dbState = {
        lastSequence: this.safeNumber(task.lastLogSequence),
        size: this.safeNumber(task.logSize),
      };
      const fileState = await this.storage.getState(payload.taskId, dbState);
      const currentSequence = fileState.lastSequence;
      const currentOffset = fileState.size;

      if (fileState.lastSequence !== dbState.lastSequence || fileState.size !== dbState.size) {
        await this.prisma.buildTask.update({
          where: { id: payload.taskId },
          data: {
            lastLogSequence: BigInt(fileState.lastSequence),
            logSize: BigInt(fileState.size),
          },
        });
      }

      if (payload.sequence <= currentSequence)
        return this.ack(payload.taskId, currentSequence, currentOffset);
      if (payload.sequence > currentSequence + 1)
        return this.ack(payload.taskId, currentSequence, currentOffset);

      const redactor = this.redactorFor(task);
      const maskedChunk = redactor.redact(payload.stream, payload.chunk);
      const entry: TaskLogEntry = {
        sequence: payload.sequence,
        stream: payload.stream,
        chunk: maskedChunk,
        emittedAt: payload.emittedAt,
      };
      const nextOffset = await this.storage.append(payload.taskId, entry);
      await this.prisma.buildTask.update({
        where: { id: payload.taskId },
        data: { lastLogSequence: BigInt(payload.sequence), logSize: BigInt(nextOffset) },
      });

      const event: TaskLogBroadcastEvent = {
        taskId: payload.taskId,
        offset: currentOffset,
        nextOffset,
        entry,
      };
      this.broadcast(event);
      return this.ack(payload.taskId, payload.sequence, nextOffset);
    });
  }

  async readHistory(
    actor: AuthenticatedRequestUser,
    taskId: string,
    offset: number,
    limit: number,
  ): Promise<TaskLogReadResult & { taskId: string; offset: number }> {
    await this.authorization.assertTaskLogAccess(actor, taskId);
    try {
      return await this.withTaskLock(taskId, async () => {
        const task = await this.prisma.buildTask.findUnique({
          where: { id: taskId },
          select: { lastLogSequence: true, logSize: true },
        });
        if (!task) throw new ApiException('RESOURCE_NOT_FOUND');
        const dbState = {
          lastSequence: this.safeNumber(task.lastLogSequence),
          size: this.safeNumber(task.logSize),
        };
        const fileState = await this.storage.getState(taskId, dbState);
        if (fileState.lastSequence !== dbState.lastSequence || fileState.size !== dbState.size) {
          await this.prisma.buildTask.update({
            where: { id: taskId },
            data: {
              lastLogSequence: BigInt(fileState.lastSequence),
              logSize: BigInt(fileState.size),
            },
          });
        }
        const result = await this.storage.read(taskId, offset, limit);
        return { taskId, offset, ...result };
      });
    } catch (error) {
      if (error instanceof TaskLogStorageError && error.kind === 'INVALID_OFFSET') {
        throw new ApiException('VALIDATION_FAILED');
      }
      throw new ApiException('RESOURCE_NOT_FOUND');
    }
  }

  subscribe(taskId: string, subscriber: Subscriber): () => void {
    let listeners = this.subscribers.get(taskId);
    if (!listeners) {
      listeners = new Set<Subscriber>();
      this.subscribers.set(taskId, listeners);
    }
    listeners.add(subscriber);
    return () => {
      const current = this.subscribers.get(taskId);
      current?.delete(subscriber);
      if (current?.size === 0) this.subscribers.delete(taskId);
    };
  }

  onModuleDestroy(): void {
    this.subscribers.clear();
    this.redactors.clear();
    this.taskLocks.clear();
  }

  private assertLogLease(task: LogTask, leaseToken: string): void {
    const now = Date.now();
    if (ACTIVE_STATUSES.has(task.status)) {
      if (
        task.agent.activeTaskId !== task.id ||
        !task.leaseHash ||
        !task.leaseExpiresAt ||
        task.leaseExpiresAt.getTime() <= now ||
        !this.hashMatches(leaseToken, task.leaseHash)
      ) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      return;
    }
    if (LOGGABLE_TERMINAL_STATUSES.has(task.status)) {
      if (
        !task.logLeaseHash ||
        !task.logLeaseExpiresAt ||
        task.logLeaseExpiresAt.getTime() <= now ||
        !this.hashMatches(leaseToken, task.logLeaseHash)
      ) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      return;
    }
    throw new ApiException('TASK_LEASE_INVALID');
  }

  private hashMatches(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(createHash('sha256').update(token, 'utf8').digest('hex'));
    const expected = Buffer.from(expectedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private redactorFor(task: LogTask): ServerLogRedactor {
    const existing = this.redactors.get(task.id);
    if (existing) return existing;
    const schemaResult = validateFormSchema(task.buildTemplate.formSchema);
    const schemaKeys = schemaResult.ok ? listSensitiveFormFieldNames(schemaResult.value) : [];
    const snapshotKeys = Array.isArray(task.logSensitiveKeys)
      ? task.logSensitiveKeys.filter((value): value is string => typeof value === 'string')
      : [];
    const keys = [...new Set([...schemaKeys, ...snapshotKeys])];
    const config = isRecord(task.config) ? task.config : {};
    const values = keys.flatMap((key) => sensitiveRepresentations(config[key]));
    const redactor = new ServerLogRedactor(values);
    this.redactors.set(task.id, redactor);
    return redactor;
  }

  private ack(taskId: string, sequence: number, offset: number): TaskLogAckMessage {
    return {
      id: `log-ack-${taskId}-${sequence}`,
      type: 'task.log.ack',
      timestamp: new Date().toISOString(),
      protocolVersion: 1,
      payload: { taskId, acknowledgedSequence: sequence, persistedOffset: offset },
    };
  }

  private broadcast(event: TaskLogBroadcastEvent): void {
    for (const subscriber of this.subscribers.get(event.taskId) ?? []) {
      try {
        subscriber(event);
      } catch {
        // A slow or closed browser subscriber must never affect log persistence.
      }
    }
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.taskLocks.set(taskId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.taskLocks.get(taskId) === current) this.taskLocks.delete(taskId);
    }
  }

  private safeNumber(value: bigint): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new ApiException('RESOURCE_NOT_FOUND');
    return result;
  }
}

function sensitiveRepresentations(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => sensitiveRepresentations(item));
  if (isRecord(value))
    return Object.values(value).flatMap((item) => sensitiveRepresentations(item));
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ServerLogRedactor {
  private readonly values: string[];
  private readonly pending = new Map<LogStream, string>();

  constructor(values: readonly string[]) {
    this.values = [...new Set(values.filter((value) => value.length > 0))].sort(
      (left, right) => right.length - left.length,
    );
  }

  redact(stream: LogStream, chunk: string): string {
    const combined = (this.pending.get(stream) ?? '') + chunk;
    this.pending.delete(stream);
    if (this.values.length === 0) return chunk;

    const masked = this.replace(combined);
    if (masked !== combined) return masked;
    let holdLength = 0;
    for (const value of this.values) {
      for (let length = 1; length < value.length && length <= combined.length; length += 1) {
        if (combined.endsWith(value.slice(0, length))) holdLength = Math.max(holdLength, length);
      }
    }
    if (holdLength === 0) return combined;
    const output = combined.slice(0, -holdLength);
    this.pending.set(stream, combined.slice(-holdLength));
    return this.replace(output);
  }

  private replace(value: string): string {
    return this.values.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
  }
}
