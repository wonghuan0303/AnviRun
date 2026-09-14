import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ConfigFilesModule } from '../config-files/config-files.module';

@Module({
  imports: [AuthModule, AuthorizationModule, ConfigFilesModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
