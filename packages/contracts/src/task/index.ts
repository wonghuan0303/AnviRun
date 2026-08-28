/** 构建任务相关的公共契约。 */

export {
  ACTIVE_TASK_STATUSES,
  AGENT_REPORTABLE_TASK_STATUSES,
  BUILD_TASK_STATUSES,
  BUILD_TASK_STATUS_INVALID_CODE,
  TASK_LEASE_RECOVERY_WINDOW_SECONDS,
  TERMINAL_TASK_STATUSES,
  isActiveTaskStatus,
  isAgentReportableTaskStatus,
  isBuildTaskStatus,
  isTerminalTaskStatus,
  parseBuildTaskStatus,
} from './task-status';
export type {
  ActiveTaskStatus,
  AgentReportableTaskStatus,
  BuildTaskStatus,
  TerminalTaskStatus,
} from './task-status';

export {
  TASK_STATUS_TRANSITIONS,
  TASK_STATUS_TRANSITION_INVALID_CODE,
  assertTaskStatusTransition,
  canTransitionTaskStatus,
  getAllowedTaskStatusTransitions,
  listTaskStatusTransitions,
} from './task-status-transitions';
export type { TaskStatusTransition } from './task-status-transitions';

export {
  LOG_STREAMS,
  LOG_STREAM_INVALID_CODE,
  TASK_LOG_CHUNK_MAX_BYTES,
  isLogStream,
  parseLogStream,
  utf8ByteLength,
} from './task-log';
export type { LogStream } from './task-log';
