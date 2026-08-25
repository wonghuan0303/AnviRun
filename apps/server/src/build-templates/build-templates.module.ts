import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminBuildTemplatesController } from './admin-build-templates.controller';
import { BuildTemplatesController } from './build-templates.controller';
import { BuildTemplatesService } from './build-templates.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminBuildTemplatesController, BuildTemplatesController],
  providers: [BuildTemplatesService],
  exports: [BuildTemplatesService],
})
export class BuildTemplatesModule {}
