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

/**
 * 以 Agent 行锁为入口，在同一可串行化事务中更新任务状态和 Agent.activeTaskId。
 *
 * T4.1 应把队列领取逻辑放在该原语之上：排队任务仍可为多条，只有领取进入
 * DISPATCHED 时占用执行槽。数据库 partial unique index 是最终兜底。
 */
export async function claimAgentExecutionSlot(
  prisma: PrismaClient,
  input: { agentId: string; taskId: string },
) {
  return prisma.$transaction(
    async (tx) => {
      const lockedAgent = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "Agent" WHERE "id" = CAST(${input.agentId} AS UUID) FOR UPDATE`,
      );

      if (lockedAgent.length === 0) {
        throw new ExecutionSlotInputError('agent does not exist');
      }

      const agent = await tx.agent.findUnique({
        where: { id: input.agentId },
        select: { activeTaskId: true },
      });

      if (agent?.activeTaskId !== null && agent?.activeTaskId !== undefined) {
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
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Agent" WHERE "id" = CAST(${input.agentId} AS UUID) FOR UPDATE`,
      );

      const agent = await tx.agent.findUnique({
        where: { id: input.agentId },
        select: { activeTaskId: true },
      });

      if (agent?.activeTaskId !== input.taskId) {
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
