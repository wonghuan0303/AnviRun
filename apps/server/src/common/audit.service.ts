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
  result?: 'SUCCESS' | 'FAILURE';
}

const SAFE_METADATA_KEYS = new Set([
  'name',
  'role',
  'agentId',
  'projectId',
  'buildTemplateId',
  'taskId',
  'previousTaskId',
  'outcome',
  'inputId',
  'sensitive',
  'byteLength',
  'errorCode',
]);

function defaultResult(action: string): 'SUCCESS' | 'FAILURE' {
  return /(?:FAILED|REJECTED)$/.test(action) ? 'FAILURE' : 'SUCCESS';
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function safeMetadata(
  metadata: AuditContext['metadata'],
  result: 'SUCCESS' | 'FAILURE',
): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = { result };
  if (!metadata) return output;

  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key) || value === null) continue;
    if (typeof value === 'string') {
      if (value.length > 256 || hasControlCharacters(value)) continue;
      output[key] = value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') output[key] = value;
  }
  return output;
}

/** 认证和用户变更共用的安全审计写入器。metadata 只接收安全上下文。 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    context: AuditContext,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const result = context.result ?? defaultResult(context.action);
    await client.auditLog.create({
      data: {
        actorId: context.actorId,
        action: context.action,
        resourceType: context.resourceType,
        resourceId: context.resourceId,
        requestId: context.requestId,
        metadata: safeMetadata(context.metadata, result),
      },
    });
  }
}
