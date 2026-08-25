import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { AccessTokenGuard } from '../auth/access-token.guard';
import { ApiException } from '../common/api-exception';
import { parsePublicBuildTemplateListQuery } from './build-template.dto';
import { BuildTemplatesService } from './build-templates.service';

@Controller('api/build-templates')
@UseGuards(AccessTokenGuard)
export class BuildTemplatesController {
  constructor(private readonly templates: BuildTemplatesService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    try {
      return await this.templates.listPublicTemplates(parsePublicBuildTemplateListQuery(query));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException('VALIDATION_FAILED');
    }
  }

  @Get(':id')
  async get(@Param('id') templateId: string) {
    return { template: await this.templates.getPublicTemplate(templateId) };
  }
}
