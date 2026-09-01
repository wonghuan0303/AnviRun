import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AccessTokenGuard } from '../auth/access-token.guard';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { OwnedResource } from '../authorization/owned-resource.decorator';
import { OwnershipGuard } from '../authorization/ownership.guard';
import { ApiException } from '../common/api-exception';
import {
  parseCancelTaskDto,
  parseCreateTaskDto,
  parseTaskListQuery,
  parseTaskLogQuery,
} from './task.dto';
import { TaskLogsService } from '../task-logs/task-logs.service';
import { TasksService } from './tasks.service';

function requestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function idempotencyKey(request: Request): string | undefined {
  const value = request.header('idempotency-key');
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw validationException();
  return value;
}

function validationException(): ApiException {
  return new ApiException('VALIDATION_FAILED');
}

@Controller('api/projects')
export class ProjectTasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post(':projectId/tasks')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('project', 'projectId')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      parseCreateTaskDto(body);
      return await this.tasks.createTask(
        actor,
        projectId,
        requestId(request),
        idempotencyKey(request),
      );
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw validationException();
    }
  }

  @Get(':projectId/tasks')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('project', 'projectId')
  async list(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedRequestUser,
  ) {
    try {
      return await this.tasks.listProjectTasks(actor, projectId, parseTaskListQuery(query));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw validationException();
    }
  }
}

@Controller('api/tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly logs: TaskLogsService,
  ) {}

  @Get(':taskId/logs')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('taskLog', 'taskId')
  async logsHistory(
    @Param('taskId') taskId: string,
    @Query() query: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedRequestUser,
  ) {
    try {
      const parsed = parseTaskLogQuery(query);
      return await this.logs.readHistory(actor, taskId, parsed.offset, parsed.limit);
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw validationException();
    }
  }

  @Get(':taskId')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('task', 'taskId')
  async get(@Param('taskId') taskId: string, @CurrentUser() actor: AuthenticatedRequestUser) {
    return this.tasks.getTask(actor, taskId);
  }

  @Post(':taskId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('task', 'taskId')
  async cancel(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      const parsed = parseCancelTaskDto(body);
      return await this.tasks.cancelTask(actor, taskId, parsed.reason, requestId(request));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw validationException();
    }
  }

  @Post(':taskId/rebuild')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('task', 'taskId')
  async rebuild(
    @Param('taskId') taskId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    return this.tasks.rebuildTask(actor, taskId, requestId(request), idempotencyKey(request));
  }
}
