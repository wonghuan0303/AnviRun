/**
 * Server → Agent 消息负载（产品设计 5.1、第 7 节、第 10 节）。
 *
 * 设计约束：
 * - **不传输 Git 凭据**：只给仓库地址与分支，认证由 Agent 主机上的 Git 环境自行处理
 *   （产品设计第 12 节，平台不管理 Git 凭据）；
 * - **普通用户配置不拼接进构建命令**：`command` 来自构建模板，`config` 是用户填写的值，
 *   两者分开传输。按产品设计第 11 节，`config` 只能由 Agent 写入工作区内的 JSON 文件，
 *   不得作为命令行参数或环境变量隐式展开，也不得做字符串插值；
 * - 任务类消息一律带 `taskId` 与 `leaseToken`，便于服务端校验上报来源。
 */

import type { FormConfigValues } from '../form-schema/values';
import type { IsoDateTimeString, ProtocolEnvelope } from './protocol';
import type { ServerToAgentMessageType } from './message-types';

/** 注册成功回执。 */
export interface AgentRegisteredPayload {
  /** 服务端认定的 Agent 标识，后续消息必须使用该值。 */
  readonly agentId: string;
  /** Agent 显示名称。 */
  readonly agentName: string;
  /** 要求的心跳间隔（秒）。 */
  readonly heartbeatIntervalSeconds: number;
  /** 超过该秒数未收到心跳即判定离线。 */
  readonly heartbeatTimeoutSeconds: number;
  /** 服务端当前时间，供 Agent 侧校正日志时间偏差。 */
  readonly serverTime: IsoDateTimeString;
}

/** 有可领取任务的通知。 */
export interface TaskAvailablePayload {
  /** 目标 Agent 标识。 */
  readonly agentId: string;
  /** 可选：当前排队任务数，仅作提示，Agent 不应依赖其精确性。 */
  readonly queuedTaskCount?: number;
}

/** 任务需要拉取的 Git 仓库信息。**不包含任何凭据。** */
export interface TaskGitSource {
  /** 仓库地址。凭据由 Agent 主机的 Git 配置提供，协议不传输。 */
  readonly url: string;
  /** 要构建的分支。 */
  readonly branch: string;
}

/** 任务派发。 */
export interface TaskAssignmentPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 一次性租约令牌，后续所有任务上报都必须携带。 */
  readonly leaseToken: string;
  /** 租约过期时间，过期后服务端不再接受该令牌的上报。 */
  readonly leaseExpiresAt: IsoDateTimeString;
  /** 接受派发的 Agent 标识。 */
  readonly agentId: string;
  /** 项目标识。 */
  readonly projectId: string;
  /** 构建模板标识。 */
  readonly buildTemplateId: string;
  /** 仓库信息。 */
  readonly git: TaskGitSource;
  /** 构建命令，完全来自构建模板，不含任何用户输入。 */
  readonly command: string;
  /** 产物目录，相对于工作区根目录。 */
  readonly artifactDir: string;
  /** 构建超时时间（秒），超时后 Agent 需终止进程树并上报失败。 */
  readonly timeoutSeconds: number;
  /**
   * 项目配置值。
   *
   * 按产品设计第 11 节，Agent 只能把这些值写入工作区内的 JSON 文件，
   * 禁止作为命令行参数或环境变量隐式展开。
   */
  readonly config: FormConfigValues;
  /** `config` 中属于敏感项的键名，日志与展示必须遮蔽。 */
  readonly sensitiveConfigKeys: readonly string[];
}

/** 任务取消请求。 */
export interface TaskCancelPayload {
  /** 任务标识。 */
  readonly taskId: string;
  /** 该任务的租约令牌，Agent 需与本地租约比对后再执行。 */
  readonly leaseToken: string;
  /** 取消请求发起时间。 */
  readonly requestedAt: IsoDateTimeString;
  /** 可选取消原因，用于日志与任务详情展示。 */
  readonly reason?: string;
}

/** Agent 令牌被吊销。收到后 Agent 必须停止上报并断开连接。 */
export interface AgentTokenRevokedPayload {
  /** 被吊销令牌所属的 Agent 标识。 */
  readonly agentId: string;
  /** 吊销时间。 */
  readonly revokedAt: IsoDateTimeString;
  /** 可选原因。 */
  readonly reason?: string;
}

/**
 * 消息类型到负载类型的静态映射。
 *
 * `extends Record<ServerToAgentMessageType, unknown>` 保证新增消息类型后
 * 若忘记补映射会直接编译失败。
 */
export interface ServerToAgentPayloadMap extends Record<ServerToAgentMessageType, unknown> {
  'agent.registered': AgentRegisteredPayload;
  'task.available': TaskAvailablePayload;
  'task.assignment': TaskAssignmentPayload;
  'task.cancel': TaskCancelPayload;
  'agent.token.revoked': AgentTokenRevokedPayload;
}

/** 按消息类型取出对应的完整消息类型。 */
export type ServerToAgentMessageOf<TType extends ServerToAgentMessageType> = ProtocolEnvelope<
  TType,
  ServerToAgentPayloadMap[TType]
>;

/** 注册成功消息。 */
export type AgentRegisteredMessage = ServerToAgentMessageOf<'agent.registered'>;
/** 任务可领取通知消息。 */
export type TaskAvailableMessage = ServerToAgentMessageOf<'task.available'>;
/** 任务派发消息。 */
export type TaskAssignmentMessage = ServerToAgentMessageOf<'task.assignment'>;
/** 任务取消消息。 */
export type TaskCancelMessage = ServerToAgentMessageOf<'task.cancel'>;
/** 令牌吊销消息。 */
export type AgentTokenRevokedMessage = ServerToAgentMessageOf<'agent.token.revoked'>;

/** Server → Agent 消息判别联合，判别属性为 `type`。 */
export type ServerToAgentMessage =
  | AgentRegisteredMessage
  | TaskAvailableMessage
  | TaskAssignmentMessage
  | TaskCancelMessage
  | AgentTokenRevokedMessage;
