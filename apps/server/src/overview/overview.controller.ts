import { Controller, Get, UseGuards } from '@nestjs/common';

import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { OverviewService } from './overview.service';

@Controller('api/overview')
@UseGuards(AccessTokenGuard)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  get(@CurrentUser() actor: AuthenticatedRequestUser) {
    return this.overview.getOverview(actor);
  }
}
