import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AccessTokenGuard } from '../auth/access-token.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { parseAgentListQuery, parseCreateAgentDto, parseUpdateAgentDto } from './agent.dto';
import { AgentsService } from './agents.service';

function requestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

@Controller('api/admin/agents')
@UseGuards(AccessTokenGuard, AdminGuard)
export class AdminAgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      const input = parseCreateAgentDto(body);
      return await this.agents.createAgent(actor.id, input.name, requestId(request));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException('VALIDATION_FAILED');
    }
  }

  @Get()
  async list(
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Query('search') search: string | undefined,
  ) {
    try {
      const query = parseAgentListQuery(page, pageSize, search);
      return this.agents.listAgents(query.page, query.pageSize, query.search);
    } catch {
      throw new ApiException('VALIDATION_FAILED');
    }
  }

  @Get(':id')
  async get(@Param('id') agentId: string) {
    return { agent: await this.agents.getAgent(agentId) };
  }

  @Patch(':id')
  async update(
    @Param('id') agentId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      const input = parseUpdateAgentDto(body);
      return await this.agents.updateAgent(actor.id, agentId, input.name, requestId(request));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException('VALIDATION_FAILED');
    }
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Param('id') agentId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    return this.agents.enableAgent(actor.id, agentId, requestId(request));
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @Param('id') agentId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    return this.agents.disableAgent(actor.id, agentId, requestId(request));
  }

  @Post(':id/token/rotate')
  @HttpCode(HttpStatus.OK)
  async rotate(
    @Param('id') agentId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    return this.agents.rotateToken(actor.id, agentId, requestId(request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') agentId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.agents.deleteAgent(actor.id, agentId, requestId(request));
  }
}
