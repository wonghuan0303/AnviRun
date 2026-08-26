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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AccessTokenGuard } from '../auth/access-token.guard';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiException } from '../common/api-exception';
import { OwnedResource } from '../authorization/owned-resource.decorator';
import { OwnershipGuard } from '../authorization/ownership.guard';
import {
  parseCreateProjectDto,
  parseProjectConfigDto,
  parseProjectListQuery,
  parseUpdateProjectDto,
} from './project.dto';
import { ProjectsService } from './projects.service';

function requestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function validationException(): ApiException {
  return new ApiException('VALIDATION_FAILED');
}

@Controller('api/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      return await this.projects.createProject(
        actor,
        parseCreateProjectDto(body),
        requestId(request),
      );
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw validationException();
    }
  }

  @Get()
  @UseGuards(AccessTokenGuard)
  async list(
    @Query() query: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedRequestUser,
  ) {
    try {
      return await this.projects.listProjects(actor, parseProjectListQuery(query));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw validationException();
    }
  }

  @Get(':projectId')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('project', 'projectId')
  async get(@Param('projectId') projectId: string, @CurrentUser() actor: AuthenticatedRequestUser) {
    return this.projects.getProject(actor, projectId);
  }

  @Patch(':projectId')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('project', 'projectId')
  async update(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      return await this.projects.updateProject(
        actor,
        projectId,
        parseUpdateProjectDto(body),
        requestId(request),
      );
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw validationException();
    }
  }

  @Put(':projectId/config')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('project', 'projectId')
  async saveConfig(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      return await this.projects.saveProjectConfig(
        actor,
        projectId,
        parseProjectConfigDto(body),
        requestId(request),
      );
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw validationException();
    }
  }

  @Delete(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('project', 'projectId')
  async remove(
    @Param('projectId') projectId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.projects.deleteProject(actor, projectId, requestId(request));
  }
}
