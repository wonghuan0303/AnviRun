import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuthorizationService } from './authorization.service';
import { OwnershipGuard } from './ownership.guard';

@Module({
  imports: [AuthModule],
  providers: [AuthorizationService, OwnershipGuard],
  exports: [AuthorizationService, OwnershipGuard],
})
export class AuthorizationModule {}
