import { Injectable } from '@nestjs/common';
import { Prisma, BuildTaskStatus } from '@prisma/client';
import { canTransitionTaskStatus } from '@buildplatform/contracts';

import { ApiException } from '../common/api-exception';

export type TaskStatusSource = 'SERVER' | 'AGENT' | 'SYSTEM' | 'USER';
export type TaskTransaction = Prisma.TransactionClient;

@Injectable()
export class TaskStateService {
  async createInitial(
    tx: TaskTransaction,
    taskId: string,
    nextStatus: BuildTaskStatus,
    source: TaskStatusSource,
    reason?: string,
  ): Promise<void> {
    const occurredAt = new Date();
    await tx.buildTaskStatusHistory.create({
      data: {
        taskId,
        fromStatus: null,
        toStatus: BuildTaskStatus.CREATED,
        source,
        reason: reason ?? null,
        occurredAt,
      },
    });

    if (nextStatus !== BuildTaskStatus.CREATED) {
      await this.transition(tx, taskId, nextStatus, source, reason, {
        statusReason: reason ?? null,
      });
    }
  }

  async transition(
    tx: TaskTransaction,
    taskId: string,
    nextStatus: BuildTaskStatus,
    source: TaskStatusSource,
    reason?: string,
    data: Prisma.BuildTaskUpdateInput = {},
  ) {
    const current = await tx.buildTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!current) throw new ApiException('RESOURCE_NOT_FOUND');
    if (current.status === nextStatus) {
      return tx.buildTask.findUniqueOrThrow({ where: { id: taskId } });
    }
    if (!canTransitionTaskStatus(current.status, nextStatus)) {
      throw new ApiException('TASK_INVALID_STATE');
    }

    const changed = await tx.buildTask.updateMany({
      where: { id: taskId, status: current.status },
      data: {
        ...data,
        ...(Object.prototype.hasOwnProperty.call(data, 'statusReason')
          ? {}
          : { statusReason: reason ?? null }),
        status: nextStatus,
      },
    });
    if (changed.count !== 1) throw new ApiException('TASK_INVALID_STATE');

    const occurredAt = new Date();
    await tx.buildTaskStatusHistory.create({
      data: {
        taskId,
        fromStatus: current.status,
        toStatus: nextStatus,
        source,
        reason: reason ?? null,
        occurredAt,
      },
    });

    return tx.buildTask.findUniqueOrThrow({ where: { id: taskId } });
  }
}
