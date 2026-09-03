import { Injectable } from '@nestjs/common';
import { BuildTaskStatus, Prisma } from '@prisma/client';
import {
  validateFormConfigValues,
  validateFormSchema,
  type FormConfigIssue,
  type FormSchema,
} from '@anvilrun/contracts';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { AuthorizationService } from '../authorization/authorization.service';
import { ApiException } from '../common/api-exception';
import { AuditService } from '../common/audit.service';
import { AgentConnectionRegistry } from '../agents/agent-connection.registry';
import { PrismaService } from '../database/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import type { TaskListQuery } from './task.dto';
import { TaskQueueService } from './task-queue.service';
import { TaskStateService } from './task-state.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const USER_SAFE_SELECT = {
  id: true,
  username: true,
  role: true,
  status: true,
} as const;

const AGENT_SAFE_SELECT = {
  id: true,
  name: true,
  enabled: true,
  status: true,
  hostname: true,
  os: true,
  arch: true,
  version: true,
  lastSeenAt: true,
} as const;

const TASK_SELECT = {
  id: true,
  projectId: true,
  buildTemplateId: true,
  agentId: true,
  createdBy: true,
  status: true,
  statusReason: true,
  branch: true,
  config: true,
  sourceCommit: true,
  exitCode: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  cancelRequestedAt: true,
  leaseExpiresAt: true,
  recoveryStatus: true,
  agentLostAt: true,
  recoveryDeadlineAt: true,
  logSize: true,
  artifactCount: true,
  artifactBytes: true,
  createdAt: true,
  updatedAt: true,
  project: {
    select: {
      id: true,
      ownerId: true,
      name: true,
      description: true,
      branch: true,
      owner: { select: USER_SAFE_SELECT },
    },
  },
  buildTemplate: {
    select: {
      id: true,
      name: true,
      description: true,
      agentId: true,
      enabled: true,
      agent: { select: AGENT_SAFE_SELECT },
    },
  },
  agent: { select: AGENT_SAFE_SELECT },
  creator: { select: USER_SAFE_SELECT },
} as const;

const TASK_DETAIL_SELECT = {
  ...TASK_SELECT,
  history: {
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      source: true,
      reason: true,
      occurredAt: true,
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.BuildTaskSelect;

const PROJECT_TASK_SELECT = {
  id: true,
  ownerId: true,
  buildTemplateId: true,
  branch: true,
  config: true,
  deletedAt: true,
  buildTemplate: {
    select: {
      id: true,
      enabled: true,
      formSchema: true,
      agent: { select: { id: true, enabled: true } },
    },
  },
} as const;

type TaskView = Prisma.BuildTaskGetPayload<{ select: typeof TASK_SELECT }>;
type TaskDetailView = Prisma.BuildTaskGetPayload<{ select: typeof TASK_DETAIL_SELECT }>;
type HistoryView = TaskDetailView['history'][number];

export interface TaskResponse extends Omit<
  TaskView,
  'logSize' | 'artifactCount' | 'artifactBytes'
> {
  readonly logSize: string;
  readonly artifactCount: string;
  readonly artifactBytes: string;
  readonly statusHistory?: readonly HistoryView[];
}

export interface TaskCompatibilityView {
  readonly valid: boolean;
  readonly effectiveConfig: Prisma.JsonValue;
  readonly missingFields: readonly string[];
  readonly obsoleteFields: readonly string[];
  readonly typeConflictFields: readonly string[];
  readonly issues: readonly FormConfigIssue[];
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function projectConfigIssues(issues: readonly FormConfigIssue[]) {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: [...issue.path],
    pointer: issue.pointer,
    ...(issue.fieldName === undefined ? {} : { fieldName: issue.fieldName }),
    ...(issue.expected === undefined ? {} : { expected: issue.expected }),
    ...(issue.actual === undefined ? {} : { actual: issue.actual }),
  }));
}

function schemaIssues(error: Extract<ReturnType<typeof validateFormSchema>, { ok: false }>) {
  return error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: [...issue.path],
    pointer: issue.pointer,
    ...(issue.fieldIndex === undefined ? {} : { fieldIndex: issue.fieldIndex }),
    ...(issue.fieldName === undefined ? {} : { fieldName: issue.fieldName }),
    ...(issue.property === undefined ? {} : { property: issue.property }),
  }));
}

function invalidConfig(issues: readonly FormConfigIssue[]): ApiException {
  return new ApiException('PROJECT_CONFIG_INVALID', {
    details: { issues: projectConfigIssues(issues) },
  });
}

function validSchema(value: unknown): FormSchema {
  const result = validateFormSchema(value);
  if (!result.ok) {
    throw new ApiException('BUILD_TEMPLATE_INVALID', { details: { issues: schemaIssues(result) } });
  }
  return result.value;
}

function toTaskResponse(task: TaskView | TaskDetailView): TaskResponse {
  const withHistory = task as TaskView & { history?: readonly HistoryView[] };
  const statusHistory = withHistory.history;
  const response = { ...task } as TaskView & { history?: readonly HistoryView[] };
  delete response.history;
  return {
    ...response,
    logSize: task.logSize.toString(),
    artifactCount: task.artifactCount.toString(),
    artifactBytes: task.artifactBytes.toString(),
    ...(statusHistory === undefined ? {} : { statusHistory }),
  };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly projects: ProjectsService,
    private readonly registry: AgentConnectionRegistry,
    private readonly state: TaskStateService,
    private readonly queue: TaskQueueService,
    private readonly audit: AuditService,
  ) {}

  async createTask(
    actor: AuthenticatedRequestUser,
    projectId: string,
    requestId?: string,
    creationIdempotencyKey?: string,
  ): Promise<{ task: TaskResponse }> {
    this.assertUuid(projectId);

    if (creationIdempotencyKey) {
      const existing = await this.prisma.buildTask.findFirst({
        where: {
          createdBy: actor.id,
          projectId,
          creationIdempotencyKey,
        },
        select: TASK_DETAIL_SELECT,
      });
      if (existing) return { task: toTaskResponse(existing) };
    }

    const current = await this.projects.getProject(actor, projectId);
    if (!current.project.buildTemplate.enabled) {
      throw new ApiException('BUILD_TEMPLATE_INVALID', { message: '构建模板已停用' });
    }
    if (!current.project.configCompatibility.agentEnabled) {
      throw new ApiException('AGENT_DISABLED');
    }
    await this.projects.assertProjectBuildable(actor, projectId);

    let task: TaskDetailView;
    try {
      task = await this.prisma.$transaction(async (tx) => {
        if (creationIdempotencyKey) {
          const existing = await tx.buildTask.findFirst({
            where: {
              createdBy: actor.id,
              projectId,
              creationIdempotencyKey,
            },
            select: TASK_DETAIL_SELECT,
          });
          if (existing) return existing;
        }
        const project = await tx.project.findFirst({
          where: this.authorization.projectScope(actor, { id: projectId }),
          select: PROJECT_TASK_SELECT,
        });
        if (!project) throw new ApiException('RESOURCE_NOT_FOUND');
        if (!project.buildTemplate.enabled) {
          throw new ApiException('BUILD_TEMPLATE_INVALID', { message: '构建模板已停用' });
        }
        if (!project.buildTemplate.agent.enabled) throw new ApiException('AGENT_DISABLED');

        const schema = validSchema(project.buildTemplate.formSchema);
        const config = validateFormConfigValues(schema, project.config);
        if (!config.ok) throw invalidConfig(config.issues);

        const queued = this.registry.isReady(project.buildTemplate.agent.id);
        const initialStatus = queued ? BuildTaskStatus.QUEUED : BuildTaskStatus.WAITING_AGENT;
        const statusReason = queued
          ? 'Waiting for Agent to claim task'
          : 'Waiting for Agent to connect';
        const created = await tx.buildTask.create({
          data: {
            projectId: project.id,
            buildTemplateId: project.buildTemplateId,
            agentId: project.buildTemplate.agent.id,
            createdBy: actor.id,
            status: BuildTaskStatus.CREATED,
            statusReason: null,
            branch: project.branch,
            config: jsonInput(config.value),
            creationIdempotencyKey: creationIdempotencyKey ?? null,
            queuedAt: queued ? new Date() : null,
          },
          select: { id: true },
        });
        await this.state.createInitial(tx, created.id, initialStatus, 'SERVER', statusReason);
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'TASK_CREATED',
            resourceType: 'BuildTask',
            resourceId: created.id,
            requestId,
            metadata: { projectId: project.id, buildTemplateId: project.buildTemplateId },
          },
          tx,
        );
        return tx.buildTask.findUniqueOrThrow({
          select: TASK_DETAIL_SELECT,
          where: { id: created.id },
        });
      });
    } catch (error) {
      if (!creationIdempotencyKey || !isUniqueViolation(error)) throw error;
      const existing = await this.prisma.buildTask.findFirst({
        where: { createdBy: actor.id, projectId, creationIdempotencyKey },
        select: TASK_DETAIL_SELECT,
      });
      if (!existing) throw error;
      task = existing;
    }

    if (task.agentId) await this.queue.notifyAvailable(task.agentId);
    return { task: toTaskResponse(task) };
  }

  async listProjectTasks(
    actor: AuthenticatedRequestUser,
    projectId: string,
    query: TaskListQuery,
  ): Promise<{ items: TaskResponse[]; page: number; pageSize: number; total: number }> {
    this.assertUuid(projectId);
    const additional: Prisma.BuildTaskWhereInput = {
      projectId,
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const where = this.authorization.taskScope(actor, additional);
    const [total, items] = await this.prisma.$transaction([
      this.prisma.buildTask.count({ where }),
      this.prisma.buildTask.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: TASK_SELECT,
      }),
    ]);
    return {
      items: items.map((item) => toTaskResponse(item)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getTask(actor: AuthenticatedRequestUser, taskId: string): Promise<{ task: TaskResponse }> {
    this.assertUuid(taskId);
    const task = await this.prisma.buildTask.findFirst({
      where: this.authorization.taskScope(actor, { id: taskId }),
      select: TASK_DETAIL_SELECT,
    });
    if (!task) throw new ApiException('RESOURCE_NOT_FOUND');
    return { task: toTaskResponse(task) };
  }

  async cancelTask(
    actor: AuthenticatedRequestUser,
    taskId: string,
    reason?: string,
    requestId?: string,
  ): Promise<{ task: TaskResponse }> {
    this.assertUuid(taskId);
    await this.authorization.assertTaskAccess(actor, taskId);
    await this.queue.requestCancellation(taskId, reason);
    await this.audit.record({
      actorId: actor.id,
      action: 'TASK_CANCEL_REQUESTED',
      resourceType: 'BuildTask',
      resourceId: taskId,
      requestId,
      metadata: { outcome: 'requested' },
    });
    return this.getTask(actor, taskId);
  }

  async rebuildTask(
    actor: AuthenticatedRequestUser,
    taskId: string,
    requestId?: string,
    creationIdempotencyKey?: string,
  ): Promise<{ task: TaskResponse }> {
    this.assertUuid(taskId);
    const previous = await this.prisma.buildTask.findFirst({
      where: this.authorization.taskScope(actor, { id: taskId }),
      select: { projectId: true },
    });
    if (!previous) throw new ApiException('RESOURCE_NOT_FOUND');
    const rebuilt = await this.createTask(
      actor,
      previous.projectId,
      requestId,
      creationIdempotencyKey,
    );
    await this.audit.record({
      actorId: actor.id,
      action: 'TASK_REBUILT',
      resourceType: 'BuildTask',
      resourceId: rebuilt.task.id,
      requestId,
      metadata: { previousTaskId: taskId },
    });
    return rebuilt;
  }

  private assertUuid(value: string): void {
    if (!UUID_PATTERN.test(value)) throw new ApiException('RESOURCE_NOT_FOUND');
  }
}
