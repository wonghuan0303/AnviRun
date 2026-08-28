import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminAgentsController } from './admin-agents.controller';
import { AgentConnectionRegistry } from './agent-connection.registry';
import { AgentGateway } from './agent.gateway';
import { AgentTokenService } from './agent-token.service';
import { AgentsService } from './agents.service';
import { TaskLogsModule } from '../task-logs/task-logs.module';

@Module({
  imports: [AuthModule, TaskLogsModule],
  controllers: [AdminAgentsController],
  providers: [AgentConnectionRegistry, AgentTokenService, AgentGateway, AgentsService],
  exports: [AgentConnectionRegistry, AgentGateway, AgentTokenService, AgentsService],
})
export class AgentsModule {}
