import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { TaskLogStorageService } from './task-log-storage.service';
import { TaskLogsService } from './task-logs.service';
import { ClientLogGateway } from './client-log.gateway';

@Module({
  imports: [AuthModule, AuthorizationModule],
  providers: [TaskLogStorageService, TaskLogsService, ClientLogGateway],
  exports: [TaskLogStorageService, TaskLogsService],
})
export class TaskLogsModule {}
