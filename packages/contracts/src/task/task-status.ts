/**
 * 构建任务状态契约。
 *
 * 状态集合与终态约束以产品设计第 7 节为准。状态转换表见 `./task-status-transitions.ts`。
 */

import { isMemberOf, parseEnumValue } from '../validation/enum';

/**
 * 全部合法构建任务状态，顺序按典型生命周期推进排列，可直接用于
 * 前端筛选下拉与数据库枚举定义。
 *
 * | 状态 | 含义 |
 * | --- | --- |
 * | `CREATED` | 任务已创建，尚未决定排队去向 |
 * | `WAITING_AGENT` | 绑定 Agent 离线，等待其上线 |
 * | `QUEUED` | Agent 在线，按创建时间在该 Agent 队列中等待 |
 * | `DISPATCHED` | 已派发并签发租约，等待 Agent 确认 |
 * | `PREPARING` | Agent 建立工作区、拉取源码、写入配置文件 |
 * | `RUNNING` | Agent 正在执行构建命令 |
 * | `UPLOADING` | 命令成功退出，正在校验并上传产物 |
 * | `SUCCEEDED` | 全部产物确认完成（终态） |
 * | `FAILED` | 准备、执行、上传阶段出错或失联超时（终态） |
 * | `CANCELING` | 已请求取消，等待 Agent 终止进程树 |
 * | `CANCELED` | 取消完成（终态） |
 * | `AGENT_LOST` | 执行期间 Agent 失联，等待恢复窗口 |
 */
export const BUILD_TASK_STATUSES = [
  'CREATED',
  'WAITING_AGENT',
  'QUEUED',
  'DISPATCHED',
  'PREPARING',
  'RUNNING',
  'UPLOADING',
  'SUCCEEDED',
  'FAILED',
  'CANCELING',
  'CANCELED',
  'AGENT_LOST',
] as const;

/** 构建任务状态。 */
export type BuildTaskStatus = (typeof BUILD_TASK_STATUSES)[number];

/** 任务状态校验失败时使用的稳定错误码。 */
export const BUILD_TASK_STATUS_INVALID_CODE = 'BUILD_TASK_STATUS_INVALID';

/**
 * 终态集合。产品设计第 7 节约束：`SUCCEEDED`、`FAILED`、`CANCELED` 为终态，
 * 任何转换都不得从终态回退。
 */
export const TERMINAL_TASK_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELED'] as const;

/** 终态。 */
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

/**
 * 活动（非终态）状态集合。
 *
 * Server 重启后需要从数据库恢复处于这些状态的任务（见产品设计第 12 节）。
 */
export const ACTIVE_TASK_STATUSES = [
  'CREATED',
  'WAITING_AGENT',
  'QUEUED',
  'DISPATCHED',
  'PREPARING',
  'RUNNING',
  'UPLOADING',
  'CANCELING',
  'AGENT_LOST',
] as const;

/** 活动（非终态）状态。 */
export type ActiveTaskStatus = (typeof ACTIVE_TASK_STATUSES)[number];

/**
 * Agent 通过 `task.status` 消息可以上报的状态。
 *
 * 终态由专用消息（`task.completed` / `task.failed` / `task.canceled`）提交，
 * 排队相关状态（`CREATED`、`WAITING_AGENT`、`QUEUED`、`DISPATCHED`）与 `AGENT_LOST`
 * 只能由 Server 依据数据库与连接状态推导，Agent 不得上报。
 */
export const AGENT_REPORTABLE_TASK_STATUSES = ['PREPARING', 'RUNNING', 'UPLOADING'] as const;

/** Agent 可通过 `task.status` 上报的状态。 */
export type AgentReportableTaskStatus = (typeof AGENT_REPORTABLE_TASK_STATUSES)[number];

/**
 * 任务租约恢复窗口（秒）。
 *
 * 见产品设计第 7 节：Agent 失联超过该窗口（建议 5 分钟）后任务失败。
 */
export const TASK_LEASE_RECOVERY_WINDOW_SECONDS = 300;

/** 判断值是否为合法构建任务状态。 */
export function isBuildTaskStatus(value: unknown): value is BuildTaskStatus {
  return isMemberOf(BUILD_TASK_STATUSES, value);
}

/**
 * 校验并返回构建任务状态。
 *
 * @throws {ContractValidationError} 取值不在 {@link BUILD_TASK_STATUSES} 中。
 */
export function parseBuildTaskStatus(value: unknown): BuildTaskStatus {
  return parseEnumValue(BUILD_TASK_STATUSES, value, {
    code: BUILD_TASK_STATUS_INVALID_CODE,
    label: 'BuildTaskStatus',
  });
}

/** 判断状态是否为终态。非法取值返回 `false`。 */
export function isTerminalTaskStatus(value: unknown): value is TerminalTaskStatus {
  return isMemberOf(TERMINAL_TASK_STATUSES, value);
}

/** 判断状态是否为活动（非终态）状态。非法取值返回 `false`。 */
export function isActiveTaskStatus(value: unknown): value is ActiveTaskStatus {
  return isMemberOf(ACTIVE_TASK_STATUSES, value);
}

/** 判断状态是否允许由 Agent 通过 `task.status` 上报。非法取值返回 `false`。 */
export function isAgentReportableTaskStatus(value: unknown): value is AgentReportableTaskStatus {
  return isMemberOf(AGENT_REPORTABLE_TASK_STATUSES, value);
}
