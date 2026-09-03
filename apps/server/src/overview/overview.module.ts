import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
