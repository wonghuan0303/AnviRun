/** Agent 相关的公共契约。 */

export {
  AGENT_HEARTBEAT_INTERVAL_SECONDS,
  AGENT_HEARTBEAT_TIMEOUT_SECONDS,
  AGENT_STATUSES,
  AGENT_STATUS_INVALID_CODE,
  canAgentAcceptTasks,
  isAgentStatus,
  parseAgentStatus,
} from './agent-status';
export type { AgentStatus } from './agent-status';
