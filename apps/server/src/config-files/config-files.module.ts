import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConfigFilesController, AgentConfigFilesController } from './config-files.controller';
import { ConfigFilesService } from './config-files.service';

@Module({
  imports: [AuthModule],
  controllers: [ConfigFilesController, AgentConfigFilesController],
  providers: [ConfigFilesService],
  exports: [ConfigFilesService],
})
export class ConfigFilesModule {}
