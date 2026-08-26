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
import { parseCreateTaskDto, parseTaskListQuery } from './task.dto';
import { TasksService } from './tasks.service';

function requestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
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
      return await this.tasks.createTask(actor, projectId, requestId(request));
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
  constructor(private readonly tasks: TasksService) {}

  @Get(':taskId')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('task', 'taskId')
  async get(@Param('taskId') taskId: string, @CurrentUser() actor: AuthenticatedRequestUser) {
    return this.tasks.getTask(actor, taskId);
  }
}
