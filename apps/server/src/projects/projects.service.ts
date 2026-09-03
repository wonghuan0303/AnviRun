import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  analyzeFormConfigCompatibility,
  validateFormConfigValues,
  validateFormSchema,
  type FormConfigCompatibility,
  type FormConfigIssue,
  type FormSchema,
} from '@anvilrun/contracts';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { AuthorizationService } from '../authorization/authorization.service';
import { ApiException } from '../common/api-exception';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import type { CreateProjectInput, ProjectListQuery, UpdateProjectInput } from './project.dto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER_SAFE_SELECT = {
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

const TEMPLATE_SAFE_SELECT = {
  id: true,
  name: true,
  description: true,
  agentId: true,
  enabled: true,
  agent: { select: AGENT_SAFE_SELECT },
} as const;

const PROJECT_SELECT = {
  id: true,
  ownerId: true,
  buildTemplateId: true,
  name: true,
  description: true,
  branch: true,
  config: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  owner: { select: OWNER_SAFE_SELECT },
  buildTemplate: { select: TEMPLATE_SAFE_SELECT },
} as const;

const PROJECT_WITH_SCHEMA_SELECT = {
  ...PROJECT_SELECT,
  buildTemplate: {
    select: {
      ...TEMPLATE_SAFE_SELECT,
      formSchema: true,
    },
  },
} as const;

type ProjectView = Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>;
type ProjectWithSchemaView = Prisma.ProjectGetPayload<{
  select: typeof PROJECT_WITH_SCHEMA_SELECT;
}>;

export interface ProjectCompatibilityView extends FormConfigCompatibility {
  readonly templateEnabled: boolean;
  readonly agentEnabled: boolean;
  readonly buildable: boolean;
}

type ProjectTemplateResponse = ProjectView['buildTemplate'] & {
  readonly formSchema?: FormSchema;
};

export interface ProjectResponse extends Omit<ProjectView, 'buildTemplate'> {
  readonly buildTemplate: ProjectTemplateResponse;
  readonly configCompatibility: ProjectCompatibilityView;
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
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

function assertValidSchema(value: unknown): FormSchema {
  const result = validateFormSchema(value);
  if (!result.ok) {
    throw new ApiException('BUILD_TEMPLATE_INVALID', {
      details: { issues: schemaIssues(result) },
    });
  }
  return result.value;
}

function projectConfigException(issues: readonly FormConfigIssue[]): ApiException {
  return new ApiException('PROJECT_CONFIG_INVALID', {
    details: { issues: projectConfigIssues(issues) },
  });
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async createProject(
    actor: AuthenticatedRequestUser,
    input: CreateProjectInput,
    requestId?: string,
  ): Promise<{ project: ProjectResponse }> {
    const project = await this.prisma.$transaction(async (transaction) => {
      const template = await transaction.buildTemplate.findUnique({
        where: { id: input.buildTemplateId },
        select: {
          id: true,
          enabled: true,
          formSchema: true,
        },
      });

      if (!template) throw new ApiException('RESOURCE_NOT_FOUND');
      if (!template.enabled) {
        throw new ApiException('BUILD_TEMPLATE_INVALID', {
          message: '构建模板已停用',
        });
      }

      const schema = assertValidSchema(template.formSchema);
      const config = validateFormConfigValues(schema, input.config);
      if (!config.ok) throw projectConfigException(config.issues);

      const created = await transaction.project.create({
        data: {
          ownerId: actor.id,
          buildTemplateId: input.buildTemplateId,
          name: input.name,
          description: input.description,
          branch: input.branch,
          config: jsonInput(config.value),
        },
        select: PROJECT_WITH_SCHEMA_SELECT,
      });

      await this.audit.record(
        {
          actorId: actor.id,
          action: 'PROJECT_CREATED',
          resourceType: 'Project',
          resourceId: created.id,
          requestId,
          metadata: {
            name: created.name,
            buildTemplateId: created.buildTemplateId,
          },
        },
        transaction,
      );

      return created;
    });

    return { project: this.toResponse(project, true) };
  }

  async listProjects(
    actor: AuthenticatedRequestUser,
    query: ProjectListQuery,
  ): Promise<{
    items: ProjectResponse[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const additional: Prisma.ProjectWhereInput = {
      ...(query.search === undefined
        ? {}
        : { name: { contains: query.search, mode: 'insensitive' } }),
      ...(query.buildTemplateId === undefined ? {} : { buildTemplateId: query.buildTemplateId }),
      ...(query.ownerId === undefined ? {} : { ownerId: query.ownerId }),
    };
    const where = this.authorization.projectScope(actor, additional);

    const [total, items] = await this.prisma.$transaction([
      this.prisma.project.count({ where }),
      this.prisma.project.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: PROJECT_WITH_SCHEMA_SELECT,
      }),
    ]);

    return {
      items: items.map((item) => this.toResponse(item)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getProject(
    actor: AuthenticatedRequestUser,
    projectId: string,
  ): Promise<{ project: ProjectResponse }> {
    this.assertProjectId(projectId);
    const project = await this.prisma.project.findFirst({
      where: this.authorization.projectScope(actor, { id: projectId }),
      select: PROJECT_WITH_SCHEMA_SELECT,
    });

    if (!project) throw new ApiException('RESOURCE_NOT_FOUND');
    return { project: this.toResponse(project, true) };
  }

  async updateProject(
    actor: AuthenticatedRequestUser,
    projectId: string,
    input: UpdateProjectInput,
    requestId?: string,
  ): Promise<{ project: ProjectResponse }> {
    this.assertProjectId(projectId);

    const project = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.project.findFirst({
        where: this.authorization.projectScope(actor, { id: projectId }),
        select: { id: true },
      });
      if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');

      const updated = await transaction.project.update({
        where: { id: projectId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
        },
        select: PROJECT_WITH_SCHEMA_SELECT,
      });

      await this.audit.record(
        {
          actorId: actor.id,
          action: 'PROJECT_UPDATED',
          resourceType: 'Project',
          resourceId: projectId,
          requestId,
          metadata: { name: updated.name },
        },
        transaction,
      );

      return updated;
    });

    return { project: this.toResponse(project, true) };
  }

  async saveProjectConfig(
    actor: AuthenticatedRequestUser,
    projectId: string,
    input: { config: unknown },
    requestId?: string,
  ): Promise<{ project: ProjectResponse }> {
    this.assertProjectId(projectId);

    const project = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.project.findFirst({
        where: this.authorization.projectScope(actor, { id: projectId }),
        select: PROJECT_WITH_SCHEMA_SELECT,
      });
      if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');

      const schema = assertValidSchema(existing.buildTemplate.formSchema);
      const config = validateFormConfigValues(schema, input.config);
      if (!config.ok) throw projectConfigException(config.issues);

      const updated = await transaction.project.update({
        where: { id: projectId },
        data: { config: jsonInput(config.value) },
        select: PROJECT_WITH_SCHEMA_SELECT,
      });

      await this.audit.record(
        {
          actorId: actor.id,
          action: 'PROJECT_CONFIG_UPDATED',
          resourceType: 'Project',
          resourceId: projectId,
          requestId,
          metadata: { name: updated.name },
        },
        transaction,
      );

      return updated;
    });

    return { project: this.toResponse(project, true) };
  }

  async deleteProject(
    actor: AuthenticatedRequestUser,
    projectId: string,
    requestId?: string,
  ): Promise<void> {
    this.assertProjectId(projectId);

    await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.project.findFirst({
        where: this.authorization.projectScope(actor, { id: projectId }),
        select: { id: true, name: true },
      });
      if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');

      await transaction.project.update({
        where: { id: projectId },
        data: { deletedAt: new Date() },
      });

      await this.audit.record(
        {
          actorId: actor.id,
          action: 'PROJECT_DELETED',
          resourceType: 'Project',
          resourceId: projectId,
          requestId,
          metadata: { name: existing.name },
        },
        transaction,
      );
    });
  }

  /** 供后续任务创建流程复用的可构建性断言；本阶段不创建任务。 */
  async assertProjectBuildable(
    actor: AuthenticatedRequestUser,
    projectId: string,
  ): Promise<ProjectResponse> {
    const result = await this.getProject(actor, projectId);
    if (!result.project.configCompatibility.buildable) {
      throw new ApiException('PROJECT_CONFIG_INVALID', {
        details: {
          issues: projectConfigIssues(result.project.configCompatibility.issues),
        },
      });
    }
    return result.project;
  }

  private toResponse(project: ProjectWithSchemaView, includeFormSchema = false): ProjectResponse {
    const template = project.buildTemplate as ProjectWithSchemaView['buildTemplate'] & {
      formSchema?: unknown;
    };
    const schema = assertValidSchema(template.formSchema);
    const { formSchema: _formSchema, ...safeTemplate } = template;
    const compatibility = this.configCompatibility(
      schema,
      project.config,
      template.enabled,
      template.agent.enabled,
    );

    return {
      ...project,
      buildTemplate: includeFormSchema ? { ...safeTemplate, formSchema: schema } : safeTemplate,
      configCompatibility: compatibility,
    };
  }

  private configCompatibility(
    schema: FormSchema,
    config: unknown,
    templateEnabled: boolean,
    agentEnabled: boolean,
  ): ProjectCompatibilityView {
    const result = analyzeFormConfigCompatibility(schema, config);
    return {
      ...result,
      templateEnabled,
      agentEnabled,
      buildable: result.valid && templateEnabled && agentEnabled,
    };
  }

  private assertProjectId(projectId: string): void {
    if (!UUID_PATTERN.test(projectId)) throw new ApiException('RESOURCE_NOT_FOUND');
  }
}
