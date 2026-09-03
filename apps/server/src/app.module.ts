import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AgentsModule } from './agents/agents.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { AuthModule } from './auth/auth.module';
import { BuildTemplatesModule } from './build-templates/build-templates.module';
import { CommonModule } from './common/common.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { ProjectsModule } from './projects/projects.module';
import { TasksModule } from './tasks/tasks.module';
import { TaskLogsModule } from './task-logs/task-logs.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { OverviewModule } from './overview/overview.module';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    CommonModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    AuthorizationModule,
    AgentsModule,
    BuildTemplatesModule,
    ProjectsModule,
    TasksModule,
    TaskLogsModule,
    ArtifactsModule,
    OverviewModule,
    UsersModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
