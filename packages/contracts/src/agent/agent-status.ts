/**
 * Agent 状态契约。
 *
 * 对应产品设计第 9 节 `Agent.status`：
 *
 * | 状态 | 含义 | 变更来源 |
 * | --- | --- | --- |
 * | `ONLINE` | 已建立 WebSocket 连接且心跳正常 | Server 根据连接与心跳推导 |
 * | `OFFLINE` | 未连接，或连续 45 秒未收到心跳 | Server 根据心跳超时推导 |
 * | `DISABLED` | 管理员停用，拒绝连接并断开既有连接 | 管理员显式操作 |
 *
 * 这是**平台侧**状态，由 Server 依据连接与管理员操作维护；Agent 自身不上报该字段。
 * 第一版不引入 `BUSY` 等运行态：Agent 当前是否忙碌由 `Agent.activeTaskId`
 * 与心跳负载中的 `currentTaskId` 表达，避免与在线状态混淆（见产品设计 2.2「一台 Agent
 * 并发执行多个任务」不在范围内）。
 */

import { isMemberOf, parseEnumValue } from '../validation/enum';

/** 全部合法 Agent 状态，顺序稳定。 */
export const AGENT_STATUSES = ['ONLINE', 'OFFLINE', 'DISABLED'] as const;

/** Agent 状态。 */
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Agent 状态校验失败时使用的稳定错误码。 */
export const AGENT_STATUS_INVALID_CODE = 'AGENT_STATUS_INVALID';

/** 判断值是否为合法 Agent 状态。 */
export function isAgentStatus(value: unknown): value is AgentStatus {
  return isMemberOf(AGENT_STATUSES, value);
}

/**
 * 校验并返回 Agent 状态。
 *
 * @throws {ContractValidationError} 取值不在 {@link AGENT_STATUSES} 中。
 */
export function parseAgentStatus(value: unknown): AgentStatus {
  return parseEnumValue(AGENT_STATUSES, value, {
    code: AGENT_STATUS_INVALID_CODE,
    label: 'AgentStatus',
  });
}

/**
 * 判断该状态下 Agent 是否可以承接新任务。
 *
 * 只有 `ONLINE` 可以派发；`OFFLINE` 时任务进入 `WAITING_AGENT`（见产品设计 5.4）。
 */
export function canAgentAcceptTasks(value: unknown): boolean {
  return value === 'ONLINE';
}

/** Agent 心跳间隔（秒）。见产品设计 5.1：Agent 每 15 秒发送心跳。 */
export const AGENT_HEARTBEAT_INTERVAL_SECONDS = 15;

/** Agent 心跳超时（秒）。见产品设计 5.1：连续 45 秒未收到心跳标记离线。 */
export const AGENT_HEARTBEAT_TIMEOUT_SECONDS = 45;
