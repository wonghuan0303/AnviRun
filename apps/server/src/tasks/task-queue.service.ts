import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentStatus, BuildTaskStatus, Prisma } from '@prisma/client';
import {
  listSensitiveFormFieldNames,
  PROTOCOL_VERSION,
  validateFormConfigValues,
  validateFormSchema,
  validateProtocolMessage,
  type FormConfigValues,
  type TaskAssignmentMessage,
  type TaskAvailableMessage,
  type TaskCancelMessage,
  type TaskCanceledMessage,
  type TaskFailedMessage,
  type TaskStatusMessage,
} from '@buildplatform/contracts';
import { randomUUID } from 'node:crypto';

import { ApiException } from '../common/api-exception';
import { PrismaService } from '../database/prisma.service';
import { lockAgentExecutionSlot } from '../database/execution-slot';
import { AgentConnectionRegistry } from '../agents/agent-connection.registry';
import { TaskLeaseService } from './task-lease.service';
import { TaskStateService } from './task-state.service';

const DISPATCH_CONFIRMATION_TIMEOUT_MS = 30_000;
const CANCELLATION_CONFIRMATION_TIMEOUT_MS = 30_000;
const CLAIM_RESULT_TTL_MS = 5 * 60_000;
const QUEUE_SCAN_INTERVAL_MS = 1_000;
const MAX_CLAIM_VALIDATION_SKIPS = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_AGENT_REASON_LENGTH = 1_024;
const LOG_LEASE_WINDOW_MS = 10 * 60_000;

const CLAIM_SELECT = {
  id: true,
  projectId: true,
  buildTemplateId: true,
  agentId: true,
  config: true,
  branch: true,
  status: true,
  updatedAt: true,
  project: { select: { deletedAt: true } },
  agent: { select: { id: true, enabled: true, status: true, activeTaskId: true } },
  buildTemplate: {
    select: {
      id: true,
      agentId: true,
      enabled: true,
      gitUrl: true,
      command: true,
      artifactDir: true,
      timeoutSeconds: true,
      formSchema: true,
    },
  },
} as const;

type ClaimResult = TaskAssignmentMessage | null;
interface StoredClaimResult {
  readonly result: ClaimResult;
  readonly expiresAt: number;
}

function safeAgentReason(value: string): string {
  const sanitized = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  return sanitized.slice(0, MAX_AGENT_REASON_LENGTH) || 'Agent task preparation failed';
}

function safeCancelReason(value?: string): string {
  if (typeof value !== 'string') return 'Cancellation requested by user';
  const sanitized = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  return sanitized.slice(0, MAX_AGENT_REASON_LENGTH) || 'Cancellation requested by user';
}
function taskAvailableMessage(agentId: string, queuedTaskCount: number): TaskAvailableMessage {
  return {
    id: randomUUID(),
    type: 'task.available',
    timestamp: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    payload: { agentId, queuedTaskCount },
  };
}

@Injectable()
export class TaskQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly inFlightClaims = new Map<string, Promise<ClaimResult>>();
  private readonly completedClaims = new Map<string, StoredClaimResult>();
  /** 明文租约仅在单 Server 进程内保留，用于向持有该租约的 Agent 发送取消请求。 */
  private readonly activeLeaseTokens = new Map<string, string>();
  private scanTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentConnectionRegistry,
    private readonly state: TaskStateService,
    private readonly leases: TaskLeaseService,
  ) {}

  onModuleInit(): void {
    this.scanTimer = setInterval(
      () => void this.reclaimTimedOutDispatches().catch(() => undefined),
      QUEUE_SCAN_INTERVAL_MS,
    );
    this.scanTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.inFlightClaims.clear();
    this.completedClaims.clear();
    this.activeLeaseTokens.clear();
  }

  async notifyAvailable(agentId: string): Promise<void> {
    if (!this.registry.isReady(agentId)) return;
    const queuedTaskCount = await this.prisma.buildTask.count({
      where: { agentId, status: BuildTaskStatus.QUEUED },
    });
    if (queuedTaskCount > 0) {
      this.registry.send(agentId, taskAvailableMessage(agentId, queuedTaskCount));
    }
  }

  async onAgentReady(agentId: string): Promise<void> {
    const ready = await this.prisma.$transaction(async (tx) => {
      const agent = await this.lockAgent(tx, agentId);
      if (!agent || !agent.enabled || agent.status !== AgentStatus.ONLINE) return false;

      const waiting = await tx.buildTask.findMany({
        where: { agentId, status: BuildTaskStatus.WAITING_AGENT },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, queuedAt: true },
      });
      for (const task of waiting) {
        await this.state.transition(
          tx,
          task.id,
          BuildTaskStatus.QUEUED,
          'SERVER',
          'Agent connected and task entered the queue',
          { queuedAt: task.queuedAt ?? new Date() },
        );
      }
      return true;
    });

    if (ready) await this.notifyAvailable(agentId);
  }

  async onAgentDisconnected(agentId: string): Promise<void> {
    const pending = await this.prisma.buildTask.findMany({
      where: {
        agentId,
        status: {
          in: [
            BuildTaskStatus.QUEUED,
            BuildTaskStatus.DISPATCHED,
            BuildTaskStatus.PREPARING,
            BuildTaskStatus.RUNNING,
            BuildTaskStatus.UPLOADING,
            BuildTaskStatus.CANCELING,
          ],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    // Use one transaction per task so a malformed task cannot roll back recovery of its siblings.
    for (const task of pending) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const agent = await this.lockAgent(tx, agentId);
          if (!agent) return;
          const current = await tx.buildTask.findUnique({
            where: { id: task.id },
            select: { id: true, agentId: true, status: true, startedAt: true },
          });
          if (!current || current.agentId !== agentId) return;
          if (current.status === BuildTaskStatus.QUEUED) {
            await this.state.transition(
              tx,
              current.id,
              BuildTaskStatus.WAITING_AGENT,
              'SYSTEM',
              'Agent disconnected while task was queued',
            );
            return;
          }
          if (
            current.status === BuildTaskStatus.DISPATCHED &&
            current.startedAt === null &&
            agent.activeTaskId === current.id
          ) {
            await this.moveDispatchedToWaiting(
              tx,
              current.id,
              'Agent disconnected before accepting task assignment',
            );
            await tx.agent.update({ where: { id: agentId }, data: { activeTaskId: null } });
            return;
          }

          if (
            (current.status === BuildTaskStatus.PREPARING ||
              current.status === BuildTaskStatus.RUNNING ||
              current.status === BuildTaskStatus.UPLOADING ||
              current.status === BuildTaskStatus.CANCELING) &&
            agent.activeTaskId === current.id
          ) {
            if (current.status === BuildTaskStatus.CANCELING) {
              await this.state.transition(
                tx,
                current.id,
                BuildTaskStatus.FAILED,
                'SYSTEM',
                'Agent disconnected before task cancellation was confirmed',
                {
                  leaseHash: null,
                  leaseExpiresAt: null,
                  finishedAt: new Date(),
                },
              );
              await tx.agent.update({ where: { id: agentId }, data: { activeTaskId: null } });
              return;
            }
            const phase = current.status.toLowerCase();
            await this.state.transition(
              tx,
              current.id,
              BuildTaskStatus.AGENT_LOST,
              'SYSTEM',
              `Agent disconnected while task was ${phase}`,
              {
                leaseHash: null,
                leaseExpiresAt: null,
              },
            );
            await this.state.transition(
              tx,
              current.id,
              BuildTaskStatus.FAILED,
              'SYSTEM',
              `Agent ${phase} was interrupted after disconnect`,
              {
                leaseHash: null,
                leaseExpiresAt: null,
                finishedAt: new Date(),
              },
            );
            await tx.agent.update({ where: { id: agentId }, data: { activeTaskId: null } });
          }
        });
        this.activeLeaseTokens.delete(task.id);
      } catch {
        // Continue recovering other queued tasks even if this task has inconsistent state.
      }
    }
  }

  async requestCancellation(taskId: string, reason?: string): Promise<void> {
    if (!UUID_PATTERN.test(taskId)) throw new ApiException('RESOURCE_NOT_FOUND');
    const safeReason = safeCancelReason(reason);
    let cancelMessage: TaskCancelMessage | undefined;
    let agentId: string | undefined;

    await this.prisma.$transaction(async (tx) => {
      const initial = await tx.buildTask.findUnique({
        where: { id: taskId },
        select: { agentId: true },
      });
      if (!initial) throw new ApiException('RESOURCE_NOT_FOUND');
      const agent = await this.lockAgent(tx, initial.agentId);
      if (!agent) throw new ApiException('RESOURCE_NOT_FOUND');
      const task = await tx.buildTask.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          agentId: true,
          status: true,
          leaseHash: true,
          leaseExpiresAt: true,
          cancelRequestedAt: true,
        },
      });
      if (!task || task.agentId !== agent.id) throw new ApiException('RESOURCE_NOT_FOUND');
      if (task.status === BuildTaskStatus.SUCCEEDED || task.status === BuildTaskStatus.FAILED) {
        throw new ApiException('TASK_INVALID_STATE');
      }
      if (task.status === BuildTaskStatus.CANCELED) {
        if (agent.activeTaskId === task.id) {
          await tx.agent.update({ where: { id: agent.id }, data: { activeTaskId: null } });
        }
        return;
      }

      const now = new Date();
      if (
        task.status === BuildTaskStatus.CREATED ||
        task.status === BuildTaskStatus.WAITING_AGENT ||
        task.status === BuildTaskStatus.QUEUED
      ) {
        await this.state.transition(tx, task.id, BuildTaskStatus.CANCELING, 'USER', safeReason, {
          cancelRequestedAt: now,
          leaseHash: null,
          leaseExpiresAt: null,
        });
        await this.state.transition(tx, task.id, BuildTaskStatus.CANCELED, 'USER', safeReason, {
          cancelRequestedAt: now,
          finishedAt: now,
          leaseHash: null,
          leaseExpiresAt: null,
        });
        if (agent.activeTaskId === task.id) {
          await tx.agent.update({ where: { id: agent.id }, data: { activeTaskId: null } });
        }
        agentId = agent.id;
        return;
      }

      if (
        task.status !== BuildTaskStatus.DISPATCHED &&
        task.status !== BuildTaskStatus.PREPARING &&
        task.status !== BuildTaskStatus.RUNNING &&
        task.status !== BuildTaskStatus.UPLOADING &&
        task.status !== BuildTaskStatus.CANCELING
      ) {
        throw new ApiException('TASK_INVALID_STATE');
      }
      if (agent.activeTaskId !== task.id || !task.leaseHash || !task.leaseExpiresAt) {
        throw new ApiException('TASK_INVALID_STATE');
      }
      if (task.status !== BuildTaskStatus.CANCELING) {
        await this.state.transition(tx, task.id, BuildTaskStatus.CANCELING, 'USER', safeReason, {
          cancelRequestedAt: now,
        });
      } else if (task.cancelRequestedAt === null) {
        await tx.buildTask.update({
          where: { id: task.id },
          data: { cancelRequestedAt: now },
        });
      }
      const leaseToken = this.activeLeaseTokens.get(task.id);
      if (leaseToken) {
        cancelMessage = {
          id: randomUUID(),
          type: 'task.cancel',
          timestamp: new Date().toISOString(),
          protocolVersion: PROTOCOL_VERSION,
          payload: {
            taskId: task.id,
            leaseToken,
            requestedAt: now.toISOString(),
            ...(safeReason ? { reason: safeReason } : {}),
          },
        };
      }
      agentId = agent.id;
    });

    if (cancelMessage && agentId) this.registry.send(agentId, cancelMessage);
  }

  async reportTaskCanceled(agentId: string, message: TaskCanceledMessage): Promise<void> {
    const payload = message.payload;
    if (!UUID_PATTERN.test(payload.taskId)) throw new ApiException('TASK_LEASE_INVALID');
    if (!this.registry.isReady(agentId)) throw new ApiException('TASK_LEASE_INVALID');
    let shouldNotify = false;
    await this.prisma.$transaction(async (tx) => {
      const agent = await this.lockAgent(tx, agentId);
      if (!agent) throw new ApiException('TASK_LEASE_INVALID');
      const task = await tx.buildTask.findUnique({
        where: { id: payload.taskId },
        select: {
          id: true,
          agentId: true,
          status: true,
          leaseHash: true,
          leaseExpiresAt: true,
        },
      });
      if (!task || task.agentId !== agentId) throw new ApiException('TASK_LEASE_INVALID');
      if (task.status === BuildTaskStatus.CANCELED) {
        if (agent.activeTaskId === task.id) {
          await tx.agent.update({ where: { id: agentId }, data: { activeTaskId: null } });
        }
        return;
      }
      if (
        agent.activeTaskId !== task.id ||
        !task.leaseHash ||
        !this.leases.verify(payload.leaseToken, task.leaseHash)
      ) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (task.status !== BuildTaskStatus.CANCELING) {
        throw new ApiException('TASK_INVALID_STATE');
      }
      await this.state.transition(
        tx,
        task.id,
        BuildTaskStatus.CANCELED,
        'AGENT',
        safeCancelReason(payload.reason) || 'Agent confirmed task cancellation',
        {
          finishedAt: new Date(),
          leaseHash: null,
          leaseExpiresAt: null,
        },
      );
      await tx.agent.update({ where: { id: agentId }, data: { activeTaskId: null } });
      shouldNotify = true;
    });
    this.activeLeaseTokens.delete(payload.taskId);
    if (shouldNotify) await this.notifyAvailable(agentId);
  }

  async claim(
    agentId: string,
    messageId: string,
    requestedTaskId?: string | null,
  ): Promise<ClaimResult> {
    const key = `${agentId}:${messageId}`;
    const stored = this.completedClaims.get(key);
    if (stored && stored.expiresAt > Date.now()) {
      if (stored.result === null) return null;
      return (await this.assignmentIsActive(agentId, stored.result.payload.taskId))
        ? stored.result
        : null;
    }
    this.completedClaims.delete(key);

    const running = this.inFlightClaims.get(key);
    if (running) return running;

    if (!this.registry.isReady(agentId)) throw new ApiException('AGENT_OFFLINE');
    const promise = this.claimInTransaction(agentId, requestedTaskId)
      .then((outcome) => {
        if (outcome.result) {
          this.activeLeaseTokens.set(
            outcome.result.payload.taskId,
            outcome.result.payload.leaseToken,
          );
        }
        this.completedClaims.set(key, {
          result: outcome.result,
          expiresAt: Date.now() + CLAIM_RESULT_TTL_MS,
        });
        this.trimClaimResults();
        if (outcome.shouldNotify) {
          void this.notifyAvailable(agentId).catch(() => undefined);
        }
        return outcome.result;
      })
      .finally(() => this.inFlightClaims.delete(key));
    this.inFlightClaims.set(key, promise);
    return promise;
  }

  async accept(agentId: string, taskId: string, leaseToken: string): Promise<void> {
    if (!UUID_PATTERN.test(taskId)) throw new ApiException('TASK_LEASE_INVALID');
    if (!this.registry.isReady(agentId)) throw new ApiException('TASK_LEASE_INVALID');

    await this.prisma.$transaction(async (tx) => {
      const agent = await this.lockAgent(tx, agentId);
      if (!agent || !agent.enabled || agent.status !== AgentStatus.ONLINE) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      const task = await tx.buildTask.findUnique({
        where: { id: taskId },
        select: { id: true, agentId: true, status: true, leaseHash: true, leaseExpiresAt: true },
      });
      if (!task || task.agentId !== agentId || agent.activeTaskId !== taskId || !task.leaseHash) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= Date.now()) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (!this.leases.verify(leaseToken, task.leaseHash)) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (task.status === BuildTaskStatus.PREPARING) return;
      if (task.status !== BuildTaskStatus.DISPATCHED) {
        throw new ApiException('TASK_INVALID_STATE');
      }
      await this.state.transition(
        tx,
        taskId,
        BuildTaskStatus.PREPARING,
        'AGENT',
        'Agent accepted task assignment',
        { startedAt: new Date(), statusReason: null },
      );
    });
  }

  async reportTaskStatus(agentId: string, message: TaskStatusMessage): Promise<void> {
    const payload = message.payload;
    const supportedStatuses = [
      BuildTaskStatus.PREPARING,
      BuildTaskStatus.RUNNING,
      BuildTaskStatus.UPLOADING,
    ];
    if (
      !UUID_PATTERN.test(payload.taskId) ||
      !supportedStatuses.includes(payload.status) ||
      (payload.status === BuildTaskStatus.PREPARING &&
        (typeof payload.sourceCommit !== 'string' ||
          !SOURCE_COMMIT_PATTERN.test(payload.sourceCommit))) ||
      (payload.sourceCommit !== undefined &&
        (typeof payload.sourceCommit !== 'string' ||
          !SOURCE_COMMIT_PATTERN.test(payload.sourceCommit)))
    ) {
      throw new ApiException('VALIDATION_FAILED');
    }
    if (!this.registry.isReady(agentId)) throw new ApiException('TASK_LEASE_INVALID');
    const sourceCommit = payload.sourceCommit?.toLowerCase();

    await this.prisma.$transaction(async (tx) => {
      const agent = await this.lockAgent(tx, agentId);
      if (!agent || !agent.enabled || agent.status !== AgentStatus.ONLINE) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      const task = await tx.buildTask.findUnique({
        where: { id: payload.taskId },
        select: {
          id: true,
          agentId: true,
          status: true,
          sourceCommit: true,
          leaseHash: true,
          leaseExpiresAt: true,
        },
      });
      if (!task || task.agentId !== agentId || agent.activeTaskId !== task.id) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (!task.leaseHash || !task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= Date.now()) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (!this.leases.verify(payload.leaseToken, task.leaseHash)) {
        throw new ApiException('TASK_LEASE_INVALID');
      }

      if (sourceCommit !== undefined) {
        if (task.sourceCommit !== null && task.sourceCommit !== sourceCommit) {
          throw new ApiException('TASK_INVALID_STATE');
        }
      }
      if (task.status === payload.status) {
        if (sourceCommit !== undefined && task.sourceCommit === null) {
          await tx.buildTask.update({ where: { id: task.id }, data: { sourceCommit } });
        }
        return;
      }
      const expectedStatus =
        payload.status === BuildTaskStatus.RUNNING
          ? BuildTaskStatus.PREPARING
          : payload.status === BuildTaskStatus.UPLOADING
            ? BuildTaskStatus.RUNNING
            : null;
      if (expectedStatus === null || task.status !== expectedStatus) {
        throw new ApiException('TASK_INVALID_STATE');
      }
      await this.state.transition(
        tx,
        task.id,
        payload.status,
        'AGENT',
        `Agent reported task ${payload.status}`,
        {
          ...(sourceCommit !== undefined && task.sourceCommit === null ? { sourceCommit } : {}),
          statusReason: null,
        },
      );
    });
  }

  async reportPreparationStatus(agentId: string, message: TaskStatusMessage): Promise<void> {
    await this.reportTaskStatus(agentId, message);
  }

  async reportPreparationFailure(agentId: string, message: TaskFailedMessage): Promise<void> {
    const payload = message.payload;
    if (!UUID_PATTERN.test(payload.taskId)) throw new ApiException('TASK_LEASE_INVALID');
    if (
      payload.exitCode !== undefined &&
      (!Number.isInteger(payload.exitCode) ||
        payload.exitCode < -2_147_483_648 ||
        payload.exitCode > 2_147_483_647)
    ) {
      throw new ApiException('VALIDATION_FAILED');
    }
    if (!this.registry.isReady(agentId)) throw new ApiException('TASK_LEASE_INVALID');
    const reason = safeAgentReason(payload.reason);
    let shouldNotify = false;

    await this.prisma.$transaction(async (tx) => {
      const agent = await this.lockAgent(tx, agentId);
      if (!agent || !agent.enabled || agent.status !== AgentStatus.ONLINE) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      const task = await tx.buildTask.findUnique({
        where: { id: payload.taskId },
        select: {
          id: true,
          agentId: true,
          status: true,
          leaseHash: true,
          leaseExpiresAt: true,
        },
      });
      if (!task || task.agentId !== agentId || agent.activeTaskId !== task.id) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (!task.leaseHash || !task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= Date.now()) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (!this.leases.verify(payload.leaseToken, task.leaseHash)) {
        throw new ApiException('TASK_LEASE_INVALID');
      }
      if (
        task.status !== BuildTaskStatus.PREPARING &&
        task.status !== BuildTaskStatus.RUNNING &&
        task.status !== BuildTaskStatus.UPLOADING &&
        task.status !== BuildTaskStatus.CANCELING
      ) {
        throw new ApiException('TASK_INVALID_STATE');
      }
      await this.state.transition(tx, task.id, BuildTaskStatus.FAILED, 'AGENT', reason, {
        leaseHash: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        statusReason: reason,
        exitCode: payload.exitCode ?? null,
      });
      await tx.agent.update({ where: { id: agentId }, data: { activeTaskId: null } });
      shouldNotify = true;
    });

    this.activeLeaseTokens.delete(payload.taskId);
    if (shouldNotify) await this.notifyAvailable(agentId);
  }
  async reclaimTimedOutDispatches(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - DISPATCH_CONFIRMATION_TIMEOUT_MS);
    const candidates = await this.prisma.buildTask.findMany({
      where: { status: BuildTaskStatus.DISPATCHED, updatedAt: { lt: cutoff } },
      select: { id: true, agentId: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    });

    for (const candidate of candidates) {
      const nextStatus = await this.prisma.$transaction(async (tx) => {
        const agent = await this.lockAgent(tx, candidate.agentId);
        if (!agent || agent.activeTaskId !== candidate.id) return null;
        const task = await tx.buildTask.findUnique({
          where: { id: candidate.id },
          select: { id: true, status: true, updatedAt: true },
        });
        if (
          !task ||
          task.status !== BuildTaskStatus.DISPATCHED ||
          task.updatedAt.getTime() >= cutoff.getTime()
        ) {
          return null;
        }
        const online =
          agent.enabled &&
          agent.status === AgentStatus.ONLINE &&
          this.registry.isReady(candidate.agentId);
        const next = online ? BuildTaskStatus.QUEUED : BuildTaskStatus.WAITING_AGENT;
        if (online) {
          await this.state.transition(
            tx,
            candidate.id,
            BuildTaskStatus.QUEUED,
            'SYSTEM',
            'Agent did not confirm task assignment before timeout',
            { leaseHash: null, leaseExpiresAt: null },
          );
        } else {
          await this.moveDispatchedToWaiting(
            tx,
            candidate.id,
            'Agent did not confirm task assignment before timeout',
          );
        }
        await tx.agent.update({ where: { id: candidate.agentId }, data: { activeTaskId: null } });
        this.activeLeaseTokens.delete(candidate.id);
        return next;
      });

      if (nextStatus === BuildTaskStatus.QUEUED) {
        await this.notifyAvailable(candidate.agentId);
      }
    }
    await this.reclaimTimedOutCancellations(now);
  }

  async reclaimTimedOutCancellations(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - CANCELLATION_CONFIRMATION_TIMEOUT_MS);
    const candidates = await this.prisma.buildTask.findMany({
      where: {
        status: BuildTaskStatus.CANCELING,
        cancelRequestedAt: { not: null, lt: cutoff },
      },
      select: { id: true, agentId: true },
      orderBy: [{ cancelRequestedAt: 'asc' }, { id: 'asc' }],
    });

    for (const candidate of candidates) {
      let recovered = false;
      try {
        recovered = await this.prisma.$transaction(async (tx) => {
          const agent = await this.lockAgent(tx, candidate.agentId);
          if (!agent) return false;
          const task = await tx.buildTask.findUnique({
            where: { id: candidate.id },
            select: { id: true, status: true, cancelRequestedAt: true },
          });
          if (
            !task ||
            task.status !== BuildTaskStatus.CANCELING ||
            !task.cancelRequestedAt ||
            task.cancelRequestedAt.getTime() >= cutoff.getTime()
          ) {
            return false;
          }
          await this.state.transition(
            tx,
            task.id,
            BuildTaskStatus.FAILED,
            'SYSTEM',
            'Agent did not confirm task cancellation before timeout',
            {
              leaseHash: null,
              leaseExpiresAt: null,
              finishedAt: new Date(),
            },
          );
          if (agent.activeTaskId === task.id) {
            await tx.agent.update({
              where: { id: agent.id },
              data: { activeTaskId: null, status: AgentStatus.OFFLINE },
            });
          }
          return true;
        });
      } catch {
        continue;
      }
      if (!recovered) continue;
      this.activeLeaseTokens.delete(candidate.id);
      this.registry.disconnect(candidate.agentId, 'task cancellation timeout');
      await this.onAgentDisconnected(candidate.agentId);
    }
  }

  private async claimInTransaction(
    agentId: string,
    requestedTaskId?: string | null,
  ): Promise<{ result: ClaimResult; shouldNotify: boolean }> {
    if (
      requestedTaskId !== undefined &&
      requestedTaskId !== null &&
      !UUID_PATTERN.test(requestedTaskId)
    ) {
      return { result: null, shouldNotify: false };
    }
    return this.prisma.$transaction(async (tx) => {
      const agent = await this.lockAgent(tx, agentId);
      if (!agent) throw new ApiException('RESOURCE_NOT_FOUND');
      if (!agent.enabled) throw new ApiException('AGENT_DISABLED');
      if (agent.status !== AgentStatus.ONLINE || !this.registry.isReady(agentId)) {
        throw new ApiException('AGENT_OFFLINE');
      }
      if (agent.activeTaskId !== null) return { result: null, shouldNotify: false };

      for (let attempt = 0; attempt < MAX_CLAIM_VALIDATION_SKIPS; attempt += 1) {
        const task = await tx.buildTask.findFirst({
          where: {
            agentId,
            status: BuildTaskStatus.QUEUED,
            ...(requestedTaskId === undefined || requestedTaskId === null
              ? {}
              : { id: requestedTaskId }),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: CLAIM_SELECT,
        });
        if (!task) return { result: null, shouldNotify: false };

        let failureReason: string | undefined;
        if (task.project.deletedAt !== null) {
          failureReason = 'Project is no longer active';
        } else if (!task.agent.enabled) {
          failureReason = 'Agent is disabled';
        } else if (task.buildTemplate.agentId !== task.agentId) {
          failureReason = 'Build template Agent binding changed';
        } else if (!task.buildTemplate.enabled) {
          failureReason = 'Build template is disabled';
        } else {
          const schema = validateFormSchema(task.buildTemplate.formSchema);
          if (!schema.ok) {
            failureReason = 'Build template schema is invalid';
          } else {
            const config = validateFormConfigValues(schema.value, task.config);
            if (!config.ok) failureReason = 'Task configuration is no longer compatible';
          }
        }
        if (failureReason !== undefined) {
          await this.failUndispatchable(tx, task.id, failureReason);
          continue;
        }

        const schema = validateFormSchema(task.buildTemplate.formSchema);
        if (!schema.ok) {
          await this.failUndispatchable(tx, task.id, 'Build template schema is invalid');
          continue;
        }
        const lease = this.leases.generate(task.buildTemplate.timeoutSeconds);
        const assignment = {
          id: randomUUID(),
          type: 'task.assignment',
          timestamp: new Date().toISOString(),
          protocolVersion: PROTOCOL_VERSION,
          payload: {
            taskId: task.id,
            leaseToken: lease.token,
            leaseExpiresAt: lease.expiresAt.toISOString(),
            agentId: task.agentId,
            projectId: task.projectId,
            buildTemplateId: task.buildTemplateId,
            git: { url: task.buildTemplate.gitUrl, branch: task.branch },
            command: task.buildTemplate.command,
            artifactDir: task.buildTemplate.artifactDir,
            timeoutSeconds: task.buildTemplate.timeoutSeconds,
            config: task.config as FormConfigValues,
            sensitiveConfigKeys: listSensitiveFormFieldNames(schema.value),
          },
        } satisfies TaskAssignmentMessage;
        if (!validateProtocolMessage(assignment).ok) {
          await this.failUndispatchable(tx, task.id, 'Task assignment failed protocol validation');
          continue;
        }
        await this.state.transition(
          tx,
          task.id,
          BuildTaskStatus.DISPATCHED,
          'SERVER',
          'Task assigned to Agent',
          {
            leaseHash: lease.hash,
            leaseExpiresAt: lease.expiresAt,
            lastLogSequence: 0,
            logSize: 0,
            logLeaseHash: lease.hash,
            logLeaseExpiresAt: new Date(lease.expiresAt.getTime() + LOG_LEASE_WINDOW_MS),
            logSensitiveKeys: listSensitiveFormFieldNames(schema.value),
            statusReason: null,
          },
        );
        await tx.agent.update({ where: { id: agentId }, data: { activeTaskId: task.id } });

        return { result: assignment, shouldNotify: false };
      }

      return { result: null, shouldNotify: true };
    });
  }
  private async failUndispatchable(tx: Prisma.TransactionClient, taskId: string, reason: string) {
    const failureReason = `Dispatch validation failed: ${reason}`;
    await this.state.transition(tx, taskId, BuildTaskStatus.DISPATCHED, 'SYSTEM', failureReason, {
      leaseHash: null,
      leaseExpiresAt: null,
      statusReason: failureReason,
    });
    await this.state.transition(tx, taskId, BuildTaskStatus.FAILED, 'SYSTEM', failureReason, {
      leaseHash: null,
      leaseExpiresAt: null,
      statusReason: failureReason,
    });
    this.activeLeaseTokens.delete(taskId);
  }

  private async moveDispatchedToWaiting(
    tx: Prisma.TransactionClient,
    taskId: string,
    reason: string,
  ): Promise<void> {
    await this.state.transition(tx, taskId, BuildTaskStatus.QUEUED, 'SYSTEM', reason, {
      leaseHash: null,
      leaseExpiresAt: null,
    });
    await this.state.transition(tx, taskId, BuildTaskStatus.WAITING_AGENT, 'SYSTEM', reason, {
      leaseHash: null,
      leaseExpiresAt: null,
    });
  }

  private async assignmentIsActive(agentId: string, taskId: string): Promise<boolean> {
    const task = await this.prisma.buildTask.findUnique({
      where: { id: taskId },
      select: { agentId: true, status: true, agent: { select: { activeTaskId: true } } },
    });
    return (
      task?.agentId === agentId &&
      task.status === BuildTaskStatus.DISPATCHED &&
      task.agent.activeTaskId === taskId
    );
  }

  private async lockAgent(
    tx: Prisma.TransactionClient,
    agentId: string,
  ): Promise<{
    id: string;
    enabled: boolean;
    status: AgentStatus;
    activeTaskId: string | null;
  } | null> {
    return lockAgentExecutionSlot(tx, agentId);
  }

  private trimClaimResults(): void {
    const now = Date.now();
    for (const [key, value] of this.completedClaims) {
      if (value.expiresAt <= now) this.completedClaims.delete(key);
    }
    while (this.completedClaims.size > 256) {
      const first = this.completedClaims.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.completedClaims.delete(first);
    }
  }
}
