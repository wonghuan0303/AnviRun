import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AgentStatus } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';

export interface AuthenticatedAgent {
  id: string;
  name: string;
  enabled: boolean;
  status: AgentStatus;
}

const AUTHENTICATED_AGENT_SELECT = {
  id: true,
  name: true,
  enabled: true,
  status: true,
} as const;

/** 生成、哈希和校验 Agent 注册令牌；明文只由调用方在创建/轮换响应中使用。 */
@Injectable()
export class AgentTokenService {
  constructor(private readonly prisma: PrismaService) {}

  generateToken(): string {
    return `bpa_${randomBytes(32).toString('base64url')}`;
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  async authenticateToken(token: string | undefined): Promise<AuthenticatedAgent | null> {
    if (!token || token.length > 512) return null;

    const agent = await this.prisma.agent.findUnique({
      where: { tokenHash: this.hashToken(token) },
      select: AUTHENTICATED_AGENT_SELECT,
    });
    if (!agent || !agent.enabled || agent.status === AgentStatus.DISABLED) return null;
    return agent;
  }
}
