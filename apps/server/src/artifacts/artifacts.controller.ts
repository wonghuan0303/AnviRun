import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { OwnedResource } from '../authorization/owned-resource.decorator';
import { OwnershipGuard } from '../authorization/ownership.guard';
import { ApiException } from '../common/api-exception';
import { ArtifactsService } from './artifacts.service';

function requestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}
function leaseToken(request: Request): string {
  const header = request.header('authorization');
  if (!header?.startsWith('Bearer ')) throw new ApiException('TASK_LEASE_INVALID');
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new ApiException('TASK_LEASE_INVALID');
  return token;
}

@Controller('api/agent/tasks')
export class AgentArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}
  @Put(':taskId/artifacts/content')
  @HttpCode(HttpStatus.OK)
  async upload(
    @Param('taskId') taskId: string,
    @Query('relativePath') relativePath: unknown,
    @Req() request: Request,
  ) {
    if (typeof relativePath !== 'string') throw new ApiException('ARTIFACT_INVALID_PATH');
    return this.artifacts.uploadFromAgent(
      taskId,
      leaseToken(request),
      relativePath,
      request as unknown as AsyncIterable<Buffer | string>,
    );
  }
}

@Controller('api/tasks')
export class TaskArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}
  @Get(':taskId/artifacts')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('task', 'taskId')
  async list(
    @Param('taskId') taskId: string,
    @Query('page') page: unknown,
    @Query('pageSize') pageSize: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
  ) {
    return this.artifacts.list(actor, taskId, page, pageSize);
  }
  @Get(':taskId/artifacts/archive')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('task', 'taskId')
  async archive(
    @Param('taskId') taskId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Res() response: Response,
  ): Promise<void> {
    await this.artifacts.archive(actor, taskId, response);
  }
}

@Controller('api/artifacts')
export class ArtifactController {
  constructor(private readonly artifacts: ArtifactsService) {}
  @Get(':artifactId/download')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('artifact', 'artifactId')
  async download(
    @Param('artifactId') artifactId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Res() response: Response,
  ): Promise<void> {
    await this.artifacts.download(actor, artifactId, response);
  }
  @Delete(':artifactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('artifact', 'artifactId')
  async remove(
    @Param('artifactId') artifactId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.artifacts.remove(actor, artifactId, requestId(request));
  }
}
