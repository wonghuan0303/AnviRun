import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { TasksModule } from '../tasks/tasks.module';
import {
  AgentArtifactsController,
  ArtifactController,
  TaskArtifactsController,
} from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';

@Module({
  imports: [AuthModule, AuthorizationModule, TasksModule],
  controllers: [AgentArtifactsController, TaskArtifactsController, ArtifactController],
  providers: [ArtifactsService],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
