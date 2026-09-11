/**
 * Agent WebSocket 消息类型注册表（产品设计第 10 节）。
 *
 * 这里是消息名与方向的唯一来源：Server 网关据此校验入站消息方向，
 * Agent 据此分发处理器。新增消息类型是兼容变更，重命名或删除属于破坏性变更
 * （见 `packages/contracts/README.md`）。
 *
 * 产物内容**不走** WebSocket：`task.artifact-manifest` 只上报清单，
 * 文件本体通过带任务租约的 HTTP 流式上传（产品设计第 10 节末）。
 */

import { isMemberOf, parseEnumValue } from '../validation/enum';

/** Server 发往 Agent 的消息类型，顺序稳定。 */
export const SERVER_TO_AGENT_MESSAGE_TYPES = [
  /** 认证通过，回传 Agent 身份与心跳参数。 */
  'agent.registered',
  /** 该 Agent 队列中出现可领取任务，Agent 应发起 `task.claim`。 */
  'task.available',
  /** Server 已连续持久化的日志序号确认。 */
  'task.log.ack',
  /** Server 已校验并登记产物清单，Agent 可以开始 HTTP 上传文件。 */
  'task.artifact-manifest-ack',
  /** Server 对断线任务给出的恢复裁决。 */
  'task.recovery',
  /** Server 已完成任务终态事务，Agent 可以清理本地任务。 */
  'task.result.ack',
  /** 派发任务并签发租约。 */
  'task.assignment',
  /** 请求取消任务，幂等（产品设计 5.5）。 */
  'task.cancel',
  /** 将一行用户输入写入交互任务的 stdin。 */
  'task.input',
  /** 令牌被轮换或 Agent 被停用，连接即将关闭。 */
  'agent.token.revoked',
] as const;

/** Server 发往 Agent 的消息类型。 */
export type ServerToAgentMessageType = (typeof SERVER_TO_AGENT_MESSAGE_TYPES)[number];

/** Agent 发往 Server 的消息类型，顺序稳定。 */
export const AGENT_TO_SERVER_MESSAGE_TYPES = [
  /** 连接建立后的首条消息，上报主机与版本信息。 */
  'agent.hello',
  /** 每 15 秒一次的心跳（见 `AGENT_HEARTBEAT_INTERVAL_SECONDS`）。 */
  'agent.heartbeat',
  /** 请求领取任务，由 Server 用数据库事务裁决。 */
  'task.claim',
  /** 确认接受派发，进入准备阶段。 */
  'task.accepted',
  /** 上报中间状态，取值限于 `AGENT_REPORTABLE_TASK_STATUSES`。 */
  'task.status',
  /** 上报日志分块，带序号以支持幂等追加与断线续传。 */
  'task.log',
  /** 上报产物清单，文件本体另走 HTTP 上传。 */
  'task.artifact-manifest',
  /** 任务成功结束（终态）。 */
  'task.completed',
  /** 任务失败结束（终态）。 */
  'task.failed',
  /** 取消完成（终态）。 */
  'task.canceled',
  /** 交互任务 stdin 写入结果。 */
  'task.input.ack',
] as const;

/** Agent 发往 Server 的消息类型。 */
export type AgentToServerMessageType = (typeof AGENT_TO_SERVER_MESSAGE_TYPES)[number];

/**
 * 全部消息类型。
 *
 * 两个方向的集合当前不相交，因此消息类型本身即可推导方向（见 {@link getMessageDirection}）。
 * 该不相交性由测试断言，新增消息时不得违反。
 */
export const PROTOCOL_MESSAGE_TYPES = [
  ...SERVER_TO_AGENT_MESSAGE_TYPES,
  ...AGENT_TO_SERVER_MESSAGE_TYPES,
] as const;

/** 任意协议消息类型。 */
export type ProtocolMessageType = (typeof PROTOCOL_MESSAGE_TYPES)[number];

/** 消息传输方向。 */
export const MESSAGE_DIRECTIONS = ['SERVER_TO_AGENT', 'AGENT_TO_SERVER'] as const;

/** 消息传输方向。 */
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** 消息类型校验失败时使用的稳定错误码。 */
export const PROTOCOL_MESSAGE_TYPE_INVALID_CODE = 'PROTOCOL_MESSAGE_TYPE_INVALID';

/** 判断值是否为已知协议消息类型。 */
export function isProtocolMessageType(value: unknown): value is ProtocolMessageType {
  return isMemberOf(PROTOCOL_MESSAGE_TYPES, value);
}

/** 判断值是否为 Server → Agent 消息类型。 */
export function isServerToAgentMessageType(value: unknown): value is ServerToAgentMessageType {
  return isMemberOf(SERVER_TO_AGENT_MESSAGE_TYPES, value);
}

/** 判断值是否为 Agent → Server 消息类型。 */
export function isAgentToServerMessageType(value: unknown): value is AgentToServerMessageType {
  return isMemberOf(AGENT_TO_SERVER_MESSAGE_TYPES, value);
}

/**
 * 校验并返回协议消息类型。
 *
 * @throws {ContractValidationError} 取值不在 {@link PROTOCOL_MESSAGE_TYPES} 中。
 */
export function parseProtocolMessageType(value: unknown): ProtocolMessageType {
  return parseEnumValue(PROTOCOL_MESSAGE_TYPES, value, {
    code: PROTOCOL_MESSAGE_TYPE_INVALID_CODE,
    label: 'ProtocolMessageType',
  });
}

/** 返回消息类型的传输方向；类型非法时返回 `undefined`。 */
export function getMessageDirection(value: unknown): MessageDirection | undefined {
  if (isServerToAgentMessageType(value)) {
    return 'SERVER_TO_AGENT';
  }

  return isAgentToServerMessageType(value) ? 'AGENT_TO_SERVER' : undefined;
}

/** 判断消息类型是否允许出现在给定方向上。 */
export function isMessageAllowedInDirection(value: unknown, direction: MessageDirection): boolean {
  return getMessageDirection(value) === direction;
}

/**
 * 由 Agent 提交任务终态的消息类型。
 *
 * 中间状态走 `task.status`，终态必须使用这三条专用消息
 * （见 `AGENT_REPORTABLE_TASK_STATUSES`）。
 */
export const TERMINAL_TASK_MESSAGE_TYPES = [
  'task.completed',
  'task.failed',
  'task.canceled',
] as const;

/** 提交任务终态的消息类型。 */
export type TerminalTaskMessageType = (typeof TERMINAL_TASK_MESSAGE_TYPES)[number];

/** 判断消息类型是否提交任务终态。 */
export function isTerminalTaskMessageType(value: unknown): value is TerminalTaskMessageType {
  return isMemberOf(TERMINAL_TASK_MESSAGE_TYPES, value);
}
