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
import {
  FormSchemaValidationError,
  parseBuildTemplateListQuery,
  parseCreateBuildTemplateDto,
  parseUpdateBuildTemplateDto,
} from './build-template.dto';
import { BuildTemplatesService } from './build-templates.service';

function requestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function formSchemaValidationException(error: FormSchemaValidationError): ApiException {
  return new ApiException('VALIDATION_FAILED', {
    details: {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: [...issue.path],
        pointer: issue.pointer,
        ...(issue.fieldIndex === undefined ? {} : { fieldIndex: issue.fieldIndex }),
        ...(issue.fieldName === undefined ? {} : { fieldName: issue.fieldName }),
        ...(issue.property === undefined ? {} : { property: issue.property }),
      })),
    },
  });
}

@Controller('api/admin/build-templates')
@UseGuards(AccessTokenGuard, AdminGuard)
export class AdminBuildTemplatesController {
  constructor(private readonly templates: BuildTemplatesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      const input = parseCreateBuildTemplateDto(body);
      return await this.templates.createTemplate(actor, input, requestId(request));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      if (error instanceof FormSchemaValidationError) {
        throw formSchemaValidationException(error);
      }
      throw new ApiException('VALIDATION_FAILED');
    }
  }

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    try {
      return await this.templates.listAdminTemplates(parseBuildTemplateListQuery(query));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException('VALIDATION_FAILED');
    }
  }

  @Get(':id')
  async get(@Param('id') templateId: string) {
    return { template: await this.templates.getAdminTemplate(templateId) };
  }

  @Patch(':id')
  async update(
    @Param('id') templateId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    try {
      const input = parseUpdateBuildTemplateDto(body);
      return await this.templates.updateTemplate(actor, templateId, input, requestId(request));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      if (error instanceof FormSchemaValidationError) {
        throw formSchemaValidationException(error);
      }
      throw new ApiException('VALIDATION_FAILED');
    }
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Param('id') templateId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    return this.templates.enableTemplate(actor, templateId, requestId(request));
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @Param('id') templateId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    return this.templates.disableTemplate(actor, templateId, requestId(request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') templateId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.templates.deleteTemplate(actor, templateId, requestId(request));
  }
}
