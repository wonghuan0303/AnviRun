import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiException } from '../common/api-exception';
import { ConfigFilesService } from './config-files.service';

@Controller('api/config-files')
export class ConfigFilesController {
  constructor(private readonly files: ConfigFilesService) {}

  @Post()
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.CREATED)
  upload(
    @Query('buildTemplateId') templateId: unknown,
    @Query('fieldName') fieldName: unknown,
    @Query('fileName') fileName: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    if (
      typeof templateId !== 'string' ||
      typeof fieldName !== 'string' ||
      typeof fileName !== 'string'
    )
      throw new ApiException('CONFIG_FILE_INVALID');
    return this.files.upload(
      actor,
      templateId,
      fieldName,
      fileName,
      request.header('content-type'),
      request.header('content-length'),
      request as unknown as AsyncIterable<Buffer | string>,
    );
  }
}

@Controller('api/agent/tasks')
export class AgentConfigFilesController {
  constructor(private readonly files: ConfigFilesService) {}

  @Get(':taskId/input-files/:fileId/content')
  async download(
    @Param('taskId') taskId: string,
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const header = request.header('authorization');
    if (!header?.startsWith('Bearer ')) throw new ApiException('TASK_LEASE_INVALID');
    await this.files.downloadForAgent(taskId, fileId, header.slice(7).trim(), response);
  }
}
