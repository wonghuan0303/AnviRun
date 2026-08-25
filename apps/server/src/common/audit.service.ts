import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';

export interface AuditContext {
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/** 认证和用户变更共用的安全审计写入器。metadata 只接收安全上下文。 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    context: AuditContext,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await client.auditLog.create({
      data: {
        actorId: context.actorId,
        action: context.action,
        resourceType: context.resourceType,
        resourceId: context.resourceId,
        requestId: context.requestId,
        metadata: context.metadata,
      },
    });
  }
}
