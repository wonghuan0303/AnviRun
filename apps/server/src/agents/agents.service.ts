import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ApiException } from '../common/api-exception';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { AgentGateway } from './agent.gateway';
import { AgentTokenService } from './agent-token.service';

const AGENT_SUMMARY_SELECT = {
  id: true,
  name: true,
  enabled: true,
  status: true,
  hostname: true,
  os: true,
  arch: true,
  version: true,
  lastSeenAt: true,
  activeTaskId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type AgentSummary = Prisma.AgentGetPayload<{ select: typeof AGENT_SUMMARY_SELECT }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertAgentId(agentId: string): void {
  if (!UUID_PATTERN.test(agentId)) throw new ApiException('RESOURCE_NOT_FOUND');
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isReferenceViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AgentTokenService,
    private readonly audit: AuditService,
    private readonly gateway: AgentGateway,
  ) {}

  async createAgent(actorId: string, name: string, requestId?: string) {
    const registrationToken = this.tokens.generateToken();
    try {
      const agent = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.agent.create({
          data: { name, tokenHash: this.tokens.hashToken(registrationToken) },
          select: AGENT_SUMMARY_SELECT,
        });
        await this.audit.record(
          {
            actorId,
            action: 'AGENT_CREATED',
            resourceType: 'Agent',
            resourceId: created.id,
            requestId,
            metadata: { name },
          },
          transaction,
        );
        return created;
      });
      return { agent, registrationToken };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException('VALIDATION_FAILED', { message: 'Agent 名称已存在' });
      }
      throw error;
    }
  }

  async listAgents(page: number, pageSize: number, search?: string) {
    const where: Prisma.AgentWhereInput = search
      ? { name: { contains: search, mode: 'insensitive' } }
      : {};
    const [total, agents] = await this.prisma.$transaction([
      this.prisma.agent.count({ where }),
      this.prisma.agent.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: AGENT_SUMMARY_SELECT,
      }),
    ]);
    return { items: agents, page, pageSize, total };
  }

  async getAgent(agentId: string): Promise<AgentSummary> {
    assertAgentId(agentId);
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: AGENT_SUMMARY_SELECT,
    });
    if (!agent) throw new ApiException('RESOURCE_NOT_FOUND');
    return agent;
  }

  async updateAgent(actorId: string, agentId: string, name: string, requestId?: string) {
    assertAgentId(agentId);
    try {
      const agent = await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.agent.findUnique({ where: { id: agentId } });
        if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');
        const updated = await transaction.agent.update({
          where: { id: agentId },
          data: { name },
          select: AGENT_SUMMARY_SELECT,
        });
        await this.audit.record(
          {
            actorId,
            action: 'AGENT_UPDATED',
            resourceType: 'Agent',
            resourceId: agentId,
            requestId,
            metadata: { name },
          },
          transaction,
        );
        return updated;
      });
      return { agent };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException('VALIDATION_FAILED', { message: 'Agent 名称已存在' });
      }
      throw error;
    }
  }

  async enableAgent(actorId: string, agentId: string, requestId?: string) {
    assertAgentId(agentId);
    const agent = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.agent.findUnique({ where: { id: agentId } });
      if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');
      const updated = await transaction.agent.update({
        where: { id: agentId },
        data: {
          enabled: true,
          status: this.gateway.isConnected(agentId) ? 'ONLINE' : 'OFFLINE',
        },
        select: AGENT_SUMMARY_SELECT,
      });
      await this.audit.record(
        {
          actorId,
          action: 'AGENT_ENABLED',
          resourceType: 'Agent',
          resourceId: agentId,
          requestId,
          metadata: {
            outcome: existing.enabled && existing.status !== 'DISABLED' ? 'noop' : 'enabled',
          },
        },
        transaction,
      );
      return updated;
    });
    return { agent };
  }

  async disableAgent(actorId: string, agentId: string, requestId?: string) {
    assertAgentId(agentId);
    const agent = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.agent.findUnique({ where: { id: agentId } });
      if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');
      const updated = await transaction.agent.update({
        where: { id: agentId },
        data: { enabled: false, status: 'DISABLED' },
        select: AGENT_SUMMARY_SELECT,
      });
      await this.audit.record(
        {
          actorId,
          action: 'AGENT_DISABLED',
          resourceType: 'Agent',
          resourceId: agentId,
          requestId,
          metadata: {
            outcome: existing.enabled || existing.status !== 'DISABLED' ? 'disabled' : 'noop',
          },
        },
        transaction,
      );
      return updated;
    });
    await this.gateway.revokeConnection(agentId, 'disabled', { markOffline: false });
    return { agent };
  }

  async rotateToken(actorId: string, agentId: string, requestId?: string) {
    assertAgentId(agentId);
    const registrationToken = this.tokens.generateToken();
    try {
      const agent = await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.agent.findUnique({ where: { id: agentId } });
        if (!existing) throw new ApiException('RESOURCE_NOT_FOUND');
        const updated = await transaction.agent.update({
          where: { id: agentId },
          data: { tokenHash: this.tokens.hashToken(registrationToken) },
          select: AGENT_SUMMARY_SELECT,
        });
        await this.audit.record(
          {
            actorId,
            action: 'AGENT_TOKEN_ROTATED',
            resourceType: 'Agent',
            resourceId: agentId,
            requestId,
            metadata: { outcome: 'rotated' },
          },
          transaction,
        );
        return updated;
      });
      await this.gateway.revokeConnection(agentId, 'rotation');
      return { agent, registrationToken };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiException('VALIDATION_FAILED');
      throw error;
    }
  }

  async deleteAgent(actorId: string, agentId: string, requestId?: string): Promise<void> {
    assertAgentId(agentId);
    try {
      await this.prisma.$transaction(async (transaction) => {
        const [templateCount, taskCount] = await Promise.all([
          transaction.buildTemplate.count({ where: { agentId } }),
          transaction.buildTask.count({ where: { agentId } }),
        ]);
        const agent = await transaction.agent.findUnique({ where: { id: agentId } });
        if (!agent) throw new ApiException('RESOURCE_NOT_FOUND');
        if (agent.activeTaskId || templateCount > 0 || taskCount > 0) {
          throw new ApiException('VALIDATION_FAILED', { message: 'Agent 仍被模板或任务引用' });
        }
        await this.gateway.revokeConnection(agentId, 'deleted', { markOffline: false });
        await transaction.agent.delete({ where: { id: agentId } });
        await this.audit.record(
          {
            actorId,
            action: 'AGENT_DELETED',
            resourceType: 'Agent',
            resourceId: agentId,
            requestId,
            metadata: { outcome: 'deleted' },
          },
          transaction,
        );
      });
    } catch (error) {
      if (isReferenceViolation(error)) {
        throw new ApiException('VALIDATION_FAILED', { message: 'Agent 仍被模板或任务引用' });
      }
      throw error;
    }
  }
}
