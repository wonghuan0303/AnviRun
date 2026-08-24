/**
 * 构建任务状态转换表。
 *
 * 本文件是 Server、测试与文档共用的唯一状态机来源（产品设计第 7 节）。修改这里等于
 * 修改协议：新增状态或放宽转换属于破坏性变更，必须同步更新
 * `packages/contracts/README.md` 与 Rust 侧的终态判定。
 *
 * 图示（产品设计第 7 节）：
 *
 * ```text
 * CREATED
 *   ├─ Agent 离线 ─> WAITING_AGENT ─┐
 *   └─ Agent 在线 ─> QUEUED ────────┤
 *                                    ▼
 *                               DISPATCHED
 *                                    ▼
 *                                PREPARING
 *                                    ▼
 *                                 RUNNING
 *                                    ▼
 *                                UPLOADING
 *                                    ▼
 *                                SUCCEEDED
 *
 * 任意非终态 ─> CANCELING ─> CANCELED
 * 准备/执行/上传阶段发生错误 ─> FAILED
 * 运行中 Agent 失联 ─> AGENT_LOST ─> 恢复原阶段或超时后 FAILED
 * ```
 *
 * 不变量（由 `task-status-transitions.spec.ts` 断言）：
 * - `SUCCEEDED`、`FAILED`、`CANCELED` 没有任何出边；
 * - 每个活动状态都能进入 `CANCELING`（`CANCELING` 自身除外）；
 * - 不存在自转换：幂等性由调用方先比较当前状态实现，而不是靠自转换表达。
 */

import { ContractValidationError, createIssue } from '../validation/issue';
import { describeToken } from '../validation/primitives';
import { BUILD_TASK_STATUSES, isBuildTaskStatus, type BuildTaskStatus } from './task-status';

/**
 * 允许的状态转换：键为来源状态，值为可进入的目标状态。
 *
 * 各条非图示直连边的依据：
 * - `WAITING_AGENT → QUEUED`：绑定 Agent 上线，任务转入该 Agent 队列（产品设计 5.4）。
 * - `QUEUED → WAITING_AGENT`：排队期间 Agent 心跳超时离线，退回等待。
 * - `WAITING_AGENT → DISPATCHED`：Agent 上线且空闲时可直接派发，无需先落 `QUEUED`。
 * - `DISPATCHED → QUEUED`：派发后 Agent 未在超时窗口内确认，回收重排（实施计划 T4.1
 *   「派发超时回收」）。
 * - `DISPATCHED → FAILED`：Agent 拒绝派发或租约签发即失效。
 * - `AGENT_LOST → DISPATCHED | PREPARING | RUNNING | UPLOADING`：重连并完成租约对账后
 *   「恢复原阶段」（产品设计第 7 节）。
 * - `CANCELING → FAILED`：取消期间无法确认终止（例如 Agent 在恢复窗口内始终未回来），
 *   任务以失败收尾，避免长期停留在 `CANCELING`。
 */
export const TASK_STATUS_TRANSITIONS: Readonly<
  Record<BuildTaskStatus, readonly BuildTaskStatus[]>
> = {
  CREATED: ['WAITING_AGENT', 'QUEUED', 'CANCELING'],
  WAITING_AGENT: ['QUEUED', 'DISPATCHED', 'CANCELING'],
  QUEUED: ['WAITING_AGENT', 'DISPATCHED', 'CANCELING'],
  DISPATCHED: ['PREPARING', 'QUEUED', 'AGENT_LOST', 'FAILED', 'CANCELING'],
  PREPARING: ['RUNNING', 'AGENT_LOST', 'FAILED', 'CANCELING'],
  RUNNING: ['UPLOADING', 'AGENT_LOST', 'FAILED', 'CANCELING'],
  UPLOADING: ['SUCCEEDED', 'AGENT_LOST', 'FAILED', 'CANCELING'],
  AGENT_LOST: ['DISPATCHED', 'PREPARING', 'RUNNING', 'UPLOADING', 'FAILED', 'CANCELING'],
  CANCELING: ['CANCELED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
};

/** 状态转换被拒绝时使用的稳定错误码。 */
export const TASK_STATUS_TRANSITION_INVALID_CODE = 'TASK_STATUS_TRANSITION_INVALID';

/**
 * 返回来源状态允许进入的目标状态列表。
 *
 * 来源状态非法时返回空数组，便于调用方统一按“无可用转换”处理。
 */
export function getAllowedTaskStatusTransitions(from: unknown): readonly BuildTaskStatus[] {
  return isBuildTaskStatus(from) ? TASK_STATUS_TRANSITIONS[from] : [];
}

/**
 * 判断状态转换是否合法。
 *
 * 以下情况均返回 `false`：
 * - `from` 或 `to` 不是合法任务状态；
 * - `from` 是终态（禁止终态回退）；
 * - `from === to`（自转换不属于状态变化）。
 */
export function canTransitionTaskStatus(from: unknown, to: unknown): boolean {
  if (!isBuildTaskStatus(from) || !isBuildTaskStatus(to)) {
    return false;
  }

  return TASK_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * 断言状态转换合法。
 *
 * Server 应把该错误映射为 API 错误码 `TASK_INVALID_STATE`（HTTP 409）。
 *
 * @throws {ContractValidationError} 转换不被 {@link TASK_STATUS_TRANSITIONS} 允许。
 */
export function assertTaskStatusTransition(from: unknown, to: unknown): BuildTaskStatus {
  if (canTransitionTaskStatus(from, to)) {
    return to as BuildTaskStatus;
  }

  const allowed = getAllowedTaskStatusTransitions(from);

  throw new ContractValidationError('BuildTaskStatus 转换校验失败', [
    createIssue(
      TASK_STATUS_TRANSITION_INVALID_CODE,
      [],
      `不允许从 ${describeToken(from)} 转换到 ${describeToken(to)}；` +
        `允许的目标状态为 [${allowed.join(', ') || '无'}]`,
    ),
  ]);
}

/** 一条状态转换边。 */
export interface TaskStatusTransition {
  readonly from: BuildTaskStatus;
  readonly to: BuildTaskStatus;
}

/**
 * 以扁平列表形式返回全部合法转换，顺序由 {@link BUILD_TASK_STATUSES} 与转换表决定，
 * 便于测试穷举与文档生成。
 */
export function listTaskStatusTransitions(): readonly TaskStatusTransition[] {
  return BUILD_TASK_STATUSES.flatMap((from) =>
    TASK_STATUS_TRANSITIONS[from].map((to) => ({ from, to })),
  );
}
