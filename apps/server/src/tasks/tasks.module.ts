import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectTasksController, TasksController } from './tasks.controller';
import { TaskLeaseService } from './task-lease.service';
import { TaskQueueService } from './task-queue.service';
import { TaskStateService } from './task-state.service';
import { TasksService } from './tasks.service';
import { TaskLogsModule } from '../task-logs/task-logs.module';

@Module({
  imports: [AuthModule, AuthorizationModule, AgentsModule, ProjectsModule, TaskLogsModule],
  controllers: [ProjectTasksController, TasksController],
  providers: [TaskStateService, TaskLeaseService, TaskQueueService, TasksService],
  exports: [TaskStateService, TaskLeaseService, TaskQueueService, TasksService],
})
export class TasksModule {}
