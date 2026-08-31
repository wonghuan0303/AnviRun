/**
 * Agent → Server 消息负载（产品设计 5.1、第 7 节、第 10 节、第 11 节）。
 *
 * 设计约束：
 * - **不通过 WebSocket 传输产物文件内容**：`task.artifact-manifest` 只描述文件清单与校验和，
 *   文件本体走独立的 HTTP 流式上传；
 * - 所有任务类消息都带 `taskId` 与 `leaseToken`，服务端据此校验上报来源是否持有有效租约；
 * - 日志分片带 `sequence` 与 `stream`，支持断线续传时的去重与乱序检测；
 * - Agent 令牌只在 WebSocket 握手阶段出现，**任何 payload 都不携带令牌**。
 */

import type { AgentReportableTaskStatus } from '../task/task-status';
import type { LogStream } from '../task/task-log';
import type { IsoDateTimeString, ProtocolEnvelope } from './protocol';
import type { AgentToServerMessageType } from './message-types';

/**
 * 断线重连时 Agent 本地仍在执行的任务。
 *
 * 服务端用它做租约对账（产品设计第 7 节、第 12 节）：租约仍有效则继续，
 * 否则要求 Agent 放弃该任务。
 */
export interface AgentCurrentTask {
  /** 任务标识。 */
  readonly taskId: string;
  /** Agent 持有的租约令牌。 */
  readonly leaseToken: string;
  /** Agent 本地认为的当前执行阶段。 */
  readonly status: AgentReportableTaskStatus;
  /** 已成功上报的最大日志序号，服务端据此告知从哪里续传。 */
  readonly lastLogSequence: number;
}

/** 连接建立后的首条消息。 */
export interface AgentHelloPayload {
  /**
   * Agent 自己记录的标识。
   *
   * 首次连接时尚未知晓，可以缺省或为 `null`；权威值由 `agent.registered` 返回。
   */
  readonly agentId?: string | null;
  /** Agent 程序版本。 */
  readonly agentVersion: string;
  /** 主机名。 */
  readonly hostname: string;
  /** 操作系统标识，例如 `windows`、`linux`、`macos`。 */
  readonly os: string;
  /** CPU 架构标识，例如 `x86_64`、`aarch64`。 */
  readonly arch: string;
  /** 工作区根目录，仅用于展示与排障。 */
  readonly workspaceRoot: string;
  /** 断线前仍在执行的任务；无则缺省或为 `null`。 */
  readonly currentTask?: AgentCurrentTask | null;
}

/** 周期心跳（默认 15 秒一次，见 `AGENT_HEARTBEAT_INTERVAL_SECONDS`）。 */
export interface AgentHeartbeatPayload {
  /** Agent 标识。 */
  readonly agentId: string;
  /** 当前正在执行的任务；空闲时为 `null`。 */
  readonly currentTaskId: string | null;
}

/**
 * 请求领取任务。
 *
 * 幂等键是信封的 `id`：重发同一条 `task.claim` 不应导致重复派发（产品设计第 12 节）。
 */
export interface TaskClaimPayload {
  /** Agent 标识。 */
  readonly agentId: string;
  /** 指定要领取的任务；不指定时由服务端选择，可缺省或为 `null`。 */
  readonly taskId?: string | null;
}

/** 确认接受派发。 */
export interface TaskAcceptedPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 派发时下发的租约令牌。 */
  readonly leaseToken: string;
  /** 接受时间。 */
  readonly acceptedAt: IsoDateTimeString;
}

/** 执行阶段变化上报。 */
export interface TaskStatusPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 租约令牌。 */
  readonly leaseToken: string;
  /** 新的执行阶段，只能是 Agent 可上报的状态。 */
  readonly status: AgentReportableTaskStatus;
  /** 状态发生时间。 */
  readonly occurredAt: IsoDateTimeString;
  /** 可选说明，必须已遮蔽敏感值。 */
  readonly reason?: string;
  /** 可选：拉取代码后解析出的提交 SHA。 */
  readonly sourceCommit?: string;
}

/** 日志分片上报。 */
export interface TaskLogPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 租约令牌。 */
  readonly leaseToken: string;
  /**
   * 单调递增的日志序号，从 1 开始，同一任务内唯一。
   *
   * 服务端用它去重与排序；断线续传时从 `lastLogSequence + 1` 继续。
   */
  readonly sequence: number;
  /** 来源流。 */
  readonly stream: LogStream;
  /** 日志文本分片，敏感值必须在 Agent 侧遮蔽后再上报（产品设计第 11 节）。 */
  readonly chunk: string;
  /** 分片产生时间。 */
  readonly emittedAt: IsoDateTimeString;
}

/** 单个产物文件的元信息。**不含文件内容。** */
export interface ArtifactManifestEntry {
  /** 相对于产物目录的路径，必须使用 `/` 分隔且不得包含 `..`。 */
  readonly relativePath: string;
  /** 文件字节数。 */
  readonly size: number;
  /** 文件内容的 SHA-256 十六进制小写摘要，供上传后校验一致性。 */
  readonly sha256: string;
}

/**
 * 产物清单上报。
 *
 * 只描述有哪些文件、多大、摘要是什么；文件本体通过独立的 HTTP 流式上传接口提交
 * （产品设计第 12 节要求上传流式处理并限制大小）。
 */
export interface TaskArtifactManifestPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 租约令牌。 */
  readonly leaseToken: string;
  /** 产物目录，相对于工作区根目录，与派发时一致。 */
  readonly artifactDir: string;
  /** 全部产物字节数之和。 */
  readonly totalBytes: number;
  /** 产物文件清单；构建成功上报时必须包含至少一个文件。 */
  readonly files: readonly ArtifactManifestEntry[];
}

/** 任务成功结束。 */
export interface TaskCompletedPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 租约令牌。 */
  readonly leaseToken: string;
  /** 构建进程退出码，成功时为 0。 */
  readonly exitCode: number;
  /** 结束时间。 */
  readonly finishedAt: IsoDateTimeString;
  /** 产物文件数量。 */
  readonly artifactCount: number;
  /** 产物总字节数。 */
  readonly artifactBytes: number;
  /** 可选：构建所用的提交 SHA。 */
  readonly sourceCommit?: string;
}

/**
 * 任务失败结束。
 *
 * v1 只用可读的 `reason` 描述失败原因：产品设计未定义失败原因枚举，
 * 提前发明枚举会把实现细节固化进协议。后续版本可以新增可选的 `failureCode`
 * 字段而不破坏兼容（见 `packages/contracts/README.md` 的协议版本规则）。
 */
export interface TaskFailedPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 租约令牌。 */
  readonly leaseToken: string;
  /** 失败原因，必须已遮蔽敏感值，且不得包含堆栈。 */
  readonly reason: string;
  /** 失败时间。 */
  readonly failedAt: IsoDateTimeString;
  /** 可选：构建进程退出码。因超时或环境检查失败而未启动进程时缺省。 */
  readonly exitCode?: number;
}

/** 任务已取消。 */
export interface TaskCanceledPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 租约令牌。 */
  readonly leaseToken: string;
  /** 取消完成时间。 */
  readonly canceledAt: IsoDateTimeString;
  /** 可选说明。 */
  readonly reason?: string;
}

/**
 * 消息类型到负载类型的静态映射。
 *
 * `extends Record<AgentToServerMessageType, unknown>` 保证新增消息类型后
 * 若忘记补映射会直接编译失败。
 */
export interface AgentToServerPayloadMap extends Record<AgentToServerMessageType, unknown> {
  'agent.hello': AgentHelloPayload;
  'agent.heartbeat': AgentHeartbeatPayload;
  'task.claim': TaskClaimPayload;
  'task.accepted': TaskAcceptedPayload;
  'task.status': TaskStatusPayload;
  'task.log': TaskLogPayload;
  'task.artifact-manifest': TaskArtifactManifestPayload;
  'task.completed': TaskCompletedPayload;
  'task.failed': TaskFailedPayload;
  'task.canceled': TaskCanceledPayload;
}

/** 按消息类型取出对应的完整消息类型。 */
export type AgentToServerMessageOf<TType extends AgentToServerMessageType> = ProtocolEnvelope<
  TType,
  AgentToServerPayloadMap[TType]
>;

/** 首条握手消息。 */
export type AgentHelloMessage = AgentToServerMessageOf<'agent.hello'>;
/** 心跳消息。 */
export type AgentHeartbeatMessage = AgentToServerMessageOf<'agent.heartbeat'>;
/** 领取任务消息。 */
export type TaskClaimMessage = AgentToServerMessageOf<'task.claim'>;
/** 接受派发消息。 */
export type TaskAcceptedMessage = AgentToServerMessageOf<'task.accepted'>;
/** 阶段上报消息。 */
export type TaskStatusMessage = AgentToServerMessageOf<'task.status'>;
/** 日志上报消息。 */
export type TaskLogMessage = AgentToServerMessageOf<'task.log'>;
/** 产物清单消息。 */
export type TaskArtifactManifestMessage = AgentToServerMessageOf<'task.artifact-manifest'>;
/** 任务成功消息。 */
export type TaskCompletedMessage = AgentToServerMessageOf<'task.completed'>;
/** 任务失败消息。 */
export type TaskFailedMessage = AgentToServerMessageOf<'task.failed'>;
/** 任务取消完成消息。 */
export type TaskCanceledMessage = AgentToServerMessageOf<'task.canceled'>;

/** Agent → Server 消息判别联合，判别属性为 `type`。 */
export type AgentToServerMessage =
  | AgentHelloMessage
  | AgentHeartbeatMessage
  | TaskClaimMessage
  | TaskAcceptedMessage
  | TaskStatusMessage
  | TaskLogMessage
  | TaskArtifactManifestMessage
  | TaskCompletedMessage
  | TaskFailedMessage
  | TaskCanceledMessage;
