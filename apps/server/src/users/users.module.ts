import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { UsersService } from './users.service';
import { AdminUsersController } from './admin-users.controller';

@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
