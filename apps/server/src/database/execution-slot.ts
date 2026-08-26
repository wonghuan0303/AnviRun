import { Prisma, PrismaClient } from '@prisma/client';

const EXECUTION_SLOT_STATUSES = [
  'DISPATCHED',
  'PREPARING',
  'RUNNING',
  'UPLOADING',
  'CANCELING',
  'AGENT_LOST',
] as const;

export class ExecutionSlotUnavailableError extends Error {
  constructor(message = 'agent execution slot is unavailable') {
    super(message);
    this.name = 'ExecutionSlotUnavailableError';
  }
}

export class ExecutionSlotInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionSlotInputError';
  }
}

type LockedAgent = {
  id: string;
  enabled: boolean;
  status: 'ONLINE' | 'OFFLINE' | 'DISABLED';
  activeTaskId: string | null;
};

/** 锁定 Agent 行并读取执行槽指针，所有任务领取/回收都复用该顺序。 */
export async function lockAgentExecutionSlot(
  tx: Prisma.TransactionClient,
  agentId: string,
): Promise<LockedAgent | null> {
  const lockedAgent = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "Agent" WHERE "id" = CAST(${agentId} AS UUID) FOR UPDATE`,
  );
  if (lockedAgent.length === 0) return null;

  return tx.agent.findUnique({
    where: { id: agentId },
    select: { id: true, enabled: true, status: true, activeTaskId: true },
  });
}

/**
 * 以 Agent 行锁为入口，在同一可串行化事务中更新任务状态和 Agent.activeTaskId。
 *
 * T4.1 队列领取逻辑与该原语使用同样的 Agent 行锁和数据库 partial unique index。
 */
export async function claimAgentExecutionSlot(
  prisma: PrismaClient,
  input: { agentId: string; taskId: string },
) {
  return prisma.$transaction(
    async (tx) => {
      const agent = await lockAgentExecutionSlot(tx, input.agentId);
      if (!agent) throw new ExecutionSlotInputError('agent does not exist');

      if (agent.activeTaskId !== null) {
        throw new ExecutionSlotUnavailableError('agent already has an active task');
      }

      const updated = await tx.buildTask.updateMany({
        where: {
          id: input.taskId,
          agentId: input.agentId,
          status: 'QUEUED',
        },
        data: { status: 'DISPATCHED' },
      });

      if (updated.count !== 1) {
        throw new ExecutionSlotInputError('task must belong to agent and be QUEUED');
      }

      await tx.agent.update({
        where: { id: input.agentId },
        data: { activeTaskId: input.taskId },
      });

      return tx.buildTask.findUniqueOrThrow({
        where: { id: input.taskId },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

/**
 * 在同一事务中把任务推进到终态并清理 Agent.activeTaskId。
 * PREPARING/RUNNING/UPLOADING/CANCELING/AGENT_LOST 仍占用执行槽，不得调用该原语。
 */
export async function releaseAgentExecutionSlot(
  prisma: PrismaClient,
  input: {
    agentId: string;
    taskId: string;
    nextStatus: 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  },
) {
  return prisma.$transaction(
    async (tx) => {
      const agent = await lockAgentExecutionSlot(tx, input.agentId);
      if (!agent) throw new ExecutionSlotInputError('agent does not exist');

      if (agent.activeTaskId !== input.taskId) {
        throw new ExecutionSlotInputError('task is not the active task for agent');
      }

      const task = await tx.buildTask.update({
        where: { id: input.taskId },
        data: { status: input.nextStatus },
      });

      await tx.agent.update({
        where: { id: input.agentId },
        data: { activeTaskId: null },
      });

      return task;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

export { EXECUTION_SLOT_STATUSES };
