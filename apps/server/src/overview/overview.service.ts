import { Injectable } from '@nestjs/common';
import { AgentStatus, BuildTaskStatus, Prisma } from '@prisma/client';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { AuthorizationService } from '../authorization/authorization.service';
import { PrismaService } from '../database/prisma.service';

const QUEUED_STATUSES: readonly BuildTaskStatus[] = [
  BuildTaskStatus.CREATED,
  BuildTaskStatus.WAITING_AGENT,
  BuildTaskStatus.QUEUED,
];

const RUNNING_STATUSES: readonly BuildTaskStatus[] = [
  BuildTaskStatus.DISPATCHED,
  BuildTaskStatus.PREPARING,
  BuildTaskStatus.RUNNING,
  BuildTaskStatus.UPLOADING,
  BuildTaskStatus.CANCELING,
  BuildTaskStatus.AGENT_LOST,
];

const ACTIVE_STATUSES = [...QUEUED_STATUSES, ...RUNNING_STATUSES];

const TERMINAL_STATUSES: BuildTaskStatus[] = [
  BuildTaskStatus.SUCCEEDED,
  BuildTaskStatus.FAILED,
  BuildTaskStatus.CANCELED,
];

const AGENT_SELECT = {
  id: true,
  name: true,
  enabled: true,
  status: true,
  hostname: true,
  lastSeenAt: true,
} as const;

const TASK_SELECT = {
  id: true,
  projectId: true,
  agentId: true,
  status: true,
  createdAt: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  updatedAt: true,
  project: { select: { id: true, name: true } },
  buildTemplate: { select: { id: true, name: true } },
} as const;

type AgentRow = Prisma.AgentGetPayload<{ select: typeof AGENT_SELECT }>;
type TaskRow = Prisma.BuildTaskGetPayload<{ select: typeof TASK_SELECT }>;

export interface OverviewTask {
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly status: BuildTaskStatus;
  readonly projectName: string;
  readonly templateName: string;
  readonly createdAt: string;
  readonly queuedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

export interface OverviewAgent {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly status: AgentStatus;
  readonly hostname: string | null;
  readonly lastSeenAt: string | null;
  readonly runningTasks: readonly OverviewTask[];
  readonly queuedTasks: readonly OverviewTask[];
  readonly recentTasks: readonly OverviewTask[];
}

export interface OverviewResponse {
  readonly generatedAt: string;
  readonly metrics: {
    readonly agentTotal: number;
    readonly onlineAgentCount: number;
    readonly runningTaskCount: number;
    readonly queuedTaskCount: number;
  };
  readonly agents: readonly OverviewAgent[];
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function taskView(task: TaskRow): OverviewTask {
  return {
    id: task.id,
    projectId: task.projectId,
    agentId: task.agentId,
    status: task.status,
    projectName: task.project.name,
    templateName: task.buildTemplate.name,
    createdAt: task.createdAt.toISOString(),
    queuedAt: iso(task.queuedAt),
    startedAt: iso(task.startedAt),
    finishedAt: iso(task.finishedAt),
    updatedAt: task.updatedAt.toISOString(),
  };
}

@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async getOverview(actor: AuthenticatedRequestUser): Promise<OverviewResponse> {
    const [agents, tasks] = await this.prisma.$transaction([
      this.prisma.agent.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: AGENT_SELECT,
      }),
      this.prisma.buildTask.findMany({
        where: this.authorization.taskScope(actor, { status: { in: ACTIVE_STATUSES } }),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: TASK_SELECT,
      }),
    ]);

    const recentTaskRowsByAgent = await Promise.all(
      agents.map((agent) =>
        this.prisma.buildTask.findMany({
          where: this.authorization.taskScope(actor, {
            agentId: agent.id,
            status: { in: TERMINAL_STATUSES },
          }),
          orderBy: [{ finishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
          take: 5,
          select: TASK_SELECT,
        }),
      ),
    );
    const recentTasksByAgent = new Map(
      agents.map((agent, index) => [
        agent.id,
        recentTaskRowsByAgent[index].map((task) => taskView(task)),
      ]),
    );

    const groups = new Map<
      string,
      { agent: AgentRow; runningTasks: OverviewTask[]; queuedTasks: OverviewTask[] }
    >();
    for (const agent of agents) {
      groups.set(agent.id, { agent, runningTasks: [], queuedTasks: [] });
    }

    let runningTaskCount = 0;
    let queuedTaskCount = 0;
    for (const task of tasks) {
      const group = groups.get(task.agentId);
      if (!group) continue;
      const view = taskView(task);
      if (RUNNING_STATUSES.includes(task.status)) {
        group.runningTasks.push(view);
        runningTaskCount += 1;
      } else if (QUEUED_STATUSES.includes(task.status)) {
        group.queuedTasks.push(view);
        queuedTaskCount += 1;
      }
    }

    const overviewAgents: OverviewAgent[] = Array.from(groups.values()).map(
      ({ agent, runningTasks, queuedTasks }) => ({
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        status: agent.status,
        hostname: agent.hostname,
        lastSeenAt: iso(agent.lastSeenAt),
        runningTasks,
        queuedTasks,
        recentTasks: recentTasksByAgent.get(agent.id) ?? [],
      }),
    );

    return {
      generatedAt: new Date().toISOString(),
      metrics: {
        agentTotal: overviewAgents.length,
        onlineAgentCount: overviewAgents.filter((agent) => agent.status === AgentStatus.ONLINE)
          .length,
        runningTaskCount,
        queuedTaskCount,
      },
      agents: overviewAgents,
    };
  }
}
