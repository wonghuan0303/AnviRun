import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import type {
  BuildTemplateListQuery,
  CreateBuildTemplateInput,
  UpdateBuildTemplateInput,
} from './build-template.dto';

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

const ADMIN_TEMPLATE_SELECT = {
  id: true,
  name: true,
  description: true,
  agentId: true,
  gitUrl: true,
  command: true,
  artifactDir: true,
  formSchema: true,
  timeoutSeconds: true,
  enabled: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  agent: { select: AGENT_SAFE_SELECT },
} as const;

const PUBLIC_TEMPLATE_SELECT = {
  id: true,
  name: true,
  description: true,
  agentId: true,
  gitUrl: true,
  formSchema: true,
  timeoutSeconds: true,
  enabled: true,
  agent: { select: AGENT_SAFE_SELECT },
} as const;

export type BuildTemplateAdminView = Prisma.BuildTemplateGetPayload<{
  select: typeof ADMIN_TEMPLATE_SELECT;
}>;

export type BuildTemplatePublicView = Prisma.BuildTemplateGetPayload<{
  select: typeof PUBLIC_TEMPLATE_SELECT;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isReferenceViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

@Injectable()
export class BuildTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createTemplate(
    actor: AuthenticatedRequestUser,
    input: CreateBuildTemplateInput,
    requestId?: string,
  ): Promise<{ template: BuildTemplateAdminView }> {
    try {
      const template = await this.prisma.$transaction(async (transaction) => {
        await this.assertEnabledAgent(input.agentId, transaction);
        const created = await transaction.buildTemplate.create({
          data: {
            name: input.name,
            description: input.description,
            agentId: input.agentId,
            gitUrl: input.gitUrl,
            command: input.command,
            artifactDir: input.artifactDir,
            formSchema: jsonInput(input.formSchema),
            timeoutSeconds: input.timeoutSeconds,
            enabled: true,
            createdBy: actor.id,
          },
          select: ADMIN_TEMPLATE_SELECT,
        });
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'BUILD_TEMPLATE_CREATED',
            resourceType: 'BuildTemplate',
            resourceId: created.id,
            requestId,
            metadata: { name: created.name, agentId: created.agentId },
          },
          transaction,
        );
        return created;
      });
      return { template };
    } catch (error) {
      this.rethrowTemplateWriteError(error);
      throw error;
    }
  }

  async listAdminTemplates(query: BuildTemplateListQuery) {
    const where: Prisma.BuildTemplateWhereInput = {
      ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
      ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
      ...(query.search === undefined
        ? {}
        : { name: { contains: query.search, mode: 'insensitive' } }),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.buildTemplate.count({ where }),
      this.prisma.buildTemplate.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: ADMIN_TEMPLATE_SELECT,
      }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async getAdminTemplate(templateId: string): Promise<BuildTemplateAdminView> {
    this.assertTemplateId(templateId);
    const template = await this.prisma.buildTemplate.findUnique({
      where: { id: templateId },
      select: ADMIN_TEMPLATE_SELECT,
    });
    if (!template) throw new ApiException('RESOURCE_NOT_FOUND');
    return template;
  }

  async updateTemplate(
    actor: AuthenticatedRequestUser,
    templateId: string,
    input: UpdateBuildTemplateInput,
    requestId?: string,
  ): Promise<{ template: BuildTemplateAdminView }> {
    this.assertTemplateId(templateId);
    try {
      const template = await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.buildTemplate.findUnique({
          where: { id: templateId },
          select: { id: true, agentId: true },
        });
        if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');

        if (input.agentId !== undefined) {
          await this.assertEnabledAgent(input.agentId, transaction);
        }

        const data: Prisma.BuildTemplateUncheckedUpdateInput = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          ...(input.gitUrl === undefined ? {} : { gitUrl: input.gitUrl }),
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.artifactDir === undefined ? {} : { artifactDir: input.artifactDir }),
          ...(input.formSchema === undefined ? {} : { formSchema: jsonInput(input.formSchema) }),
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
        };
        const updated = await transaction.buildTemplate.update({
          where: { id: templateId },
          data,
          select: ADMIN_TEMPLATE_SELECT,
        });
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'BUILD_TEMPLATE_UPDATED',
            resourceType: 'BuildTemplate',
            resourceId: templateId,
            requestId,
            metadata: {
              name: updated.name,
              agentId: updated.agentId,
              ...(existing.agentId === updated.agentId ? {} : { agentChanged: true }),
            },
          },
          transaction,
        );
        return updated;
      });
      return { template };
    } catch (error) {
      this.rethrowTemplateWriteError(error);
      throw error;
    }
  }

  async enableTemplate(
    actor: AuthenticatedRequestUser,
    templateId: string,
    requestId?: string,
  ): Promise<{ template: BuildTemplateAdminView }> {
    this.assertTemplateId(templateId);
    const template = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.buildTemplate.findUnique({
        where: { id: templateId },
        select: { id: true, agentId: true, enabled: true },
      });
      if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');
      await this.assertEnabledAgent(existing.agentId, transaction);
      const updated = await transaction.buildTemplate.update({
        where: { id: templateId },
        data: { enabled: true },
        select: ADMIN_TEMPLATE_SELECT,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'BUILD_TEMPLATE_ENABLED',
          resourceType: 'BuildTemplate',
          resourceId: templateId,
          requestId,
          metadata: { outcome: existing.enabled ? 'noop' : 'enabled' },
        },
        transaction,
      );
      return updated;
    });
    return { template };
  }

  async disableTemplate(
    actor: AuthenticatedRequestUser,
    templateId: string,
    requestId?: string,
  ): Promise<{ template: BuildTemplateAdminView }> {
    this.assertTemplateId(templateId);
    const template = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.buildTemplate.findUnique({
        where: { id: templateId },
        select: { id: true, enabled: true },
      });
      if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');
      const updated = await transaction.buildTemplate.update({
        where: { id: templateId },
        data: { enabled: false },
        select: ADMIN_TEMPLATE_SELECT,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'BUILD_TEMPLATE_DISABLED',
          resourceType: 'BuildTemplate',
          resourceId: templateId,
          requestId,
          metadata: { outcome: existing.enabled ? 'disabled' : 'noop' },
        },
        transaction,
      );
      return updated;
    });
    return { template };
  }

  async deleteTemplate(actor: AuthenticatedRequestUser, templateId: string, requestId?: string) {
    this.assertTemplateId(templateId);
    try {
      await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.buildTemplate.findUnique({
          where: { id: templateId },
          select: { id: true },
        });
        if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');

        const [projectCount, taskCount] = await Promise.all([
          transaction.project.count({ where: { buildTemplateId: templateId } }),
          transaction.buildTask.count({ where: { buildTemplateId: templateId } }),
        ]);
        if (projectCount > 0 || taskCount > 0) {
          throw new ApiException('BUILD_TEMPLATE_INVALID', {
            status: 409,
            message: '构建模板仍被项目或任务引用',
          });
        }

        await transaction.buildTemplate.delete({ where: { id: templateId } });
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'BUILD_TEMPLATE_DELETED',
            resourceType: 'BuildTemplate',
            resourceId: templateId,
            requestId,
            metadata: { outcome: 'deleted' },
          },
          transaction,
        );
      });
    } catch (error) {
      if (isReferenceViolation(error)) {
        throw new ApiException('BUILD_TEMPLATE_INVALID', {
          status: 409,
          message: '构建模板仍被项目或任务引用',
        });
      }
      throw error;
    }
  }

  async listPublicTemplates(query: { page: number; pageSize: number }) {
    const where: Prisma.BuildTemplateWhereInput = { enabled: true };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.buildTemplate.count({ where }),
      this.prisma.buildTemplate.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: PUBLIC_TEMPLATE_SELECT,
      }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async getPublicTemplate(templateId: string): Promise<BuildTemplatePublicView> {
    this.assertTemplateId(templateId);
    const template = await this.prisma.buildTemplate.findFirst({
      where: { id: templateId, enabled: true },
      select: PUBLIC_TEMPLATE_SELECT,
    });
    if (!template) throw new ApiException('RESOURCE_NOT_FOUND');
    return template;
  }

  private async assertEnabledAgent(
    agentId: string,
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<void> {
    const agent = await client.agent.findUnique({
      where: { id: agentId },
      select: { id: true, enabled: true },
    });
    if (!agent) throw new ApiException('RESOURCE_NOT_FOUND');
    if (!agent.enabled) throw new ApiException('AGENT_DISABLED');
  }

  private assertTemplateId(templateId: string): void {
    if (!UUID_PATTERN.test(templateId)) throw new ApiException('RESOURCE_NOT_FOUND');
  }

  private rethrowTemplateWriteError(error: unknown): void {
    if (isUniqueViolation(error)) {
      throw new ApiException('BUILD_TEMPLATE_INVALID', {
        message: '同一 Agent 下模板名称已存在',
      });
    }
  }
}
