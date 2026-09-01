/** WebSocket 协议契约（仅定义消息与校验，不建立网络连接）。 */

export {
  LEASE_TOKEN_PATTERN,
  PROTOCOL_ENVELOPE_PROPERTIES,
  PROTOCOL_ID_PATTERN,
  PROTOCOL_VERSION,
  MAX_AGENT_WS_MESSAGE_BYTES,
  MAX_CLIENT_WS_MESSAGE_BYTES,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
} from './protocol';
export type { IsoDateTimeString, ProtocolEnvelope, SupportedProtocolVersion } from './protocol';

export {
  AGENT_TO_SERVER_MESSAGE_TYPES,
  MESSAGE_DIRECTIONS,
  PROTOCOL_MESSAGE_TYPES,
  SERVER_TO_AGENT_MESSAGE_TYPES,
  TERMINAL_TASK_MESSAGE_TYPES,
  getMessageDirection,
  isAgentToServerMessageType,
  isMessageAllowedInDirection,
  isProtocolMessageType,
  isServerToAgentMessageType,
  isTerminalTaskMessageType,
  parseProtocolMessageType,
} from './message-types';
export type {
  AgentToServerMessageType,
  MessageDirection,
  ProtocolMessageType,
  ServerToAgentMessageType,
  TerminalTaskMessageType,
} from './message-types';

export type * from './server-to-agent';
export type * from './agent-to-server';

export {
  PROTOCOL_MESSAGE_ISSUE_CODES,
  isProtocolMessage,
  parseProtocolMessage,
  validateProtocolMessage,
} from './validate';
export type {
  ProtocolMessage,
  ProtocolMessageIssue,
  ProtocolMessageIssueCode,
  ProtocolMessageValidationFailure,
  ProtocolMessageValidationResult,
} from './validate';
