/**
 * WebSocket 协议信封与版本规则（产品设计 5.1、第 10 节）。
 *
 * 三侧（Server、Agent、Web 调试工具）共用同一个信封结构。信封只描述“这是哪一类消息、
 * 什么时候发出、用哪个协议版本”，具体语义由 `payload` 承担。
 *
 * 安全前提：
 * - Agent 身份在 WebSocket 握手阶段通过 `Authorization` 头认证，**任何消息 payload 都不携带
 *   Agent 令牌**；
 * - **协议不传输 Git 凭据**；
 * - **不通过 WebSocket 传输产物文件内容**，产物只传清单与元信息。
 */

/** 当前协议版本。 */
export const PROTOCOL_VERSION = 1;

/** Agent 单条 WebSocket 消息的服务端上限；manifest 也必须遵守该限制。 */
export const MAX_AGENT_WS_MESSAGE_BYTES = 1 * 1024 * 1024;

/** 浏览器日志订阅 WebSocket 单条消息的服务端上限。 */
export const MAX_CLIENT_WS_MESSAGE_BYTES = 64 * 1024;

/**
 * 本实现能够处理的协议版本集合。
 *
 * 收到不在集合内的版本必须拒绝并断开，不做“尽力解析”：
 * 静默降级会让不兼容问题延迟到任务执行阶段才暴露。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

/** 受支持的协议版本。 */
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** 判断是否为受支持的协议版本。 */
export function isSupportedProtocolVersion(value: unknown): value is SupportedProtocolVersion {
  return (
    typeof value === 'number' && (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(value)
  );
}

/**
 * ISO 8601 UTC 时间戳字符串，例如 `2026-08-24T03:04:05.123Z`。
 *
 * 协议中**所有时间统一用该格式**：必须是 UTC，必须以字面量 `Z` 结尾，
 * 不接受 `+08:00` 偏移量，也不接受时间戳数字。校验见 `isIso8601UtcString`。
 */
export type IsoDateTimeString = string;

/**
 * 协议内标识符的格式：Base64URL 字符集，长度 1–128。
 *
 * 覆盖 cuid、uuid、nanoid 等常见形态，同时保证标识符可以安全地拼进日志与文件名。
 * 用于消息 `id`、`agentId`、`taskId`、`projectId`、`buildTemplateId`。
 */
export const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 任务租约令牌格式：Base64URL 字符集，长度 16–256。
 *
 * 下限 16 是为了保证令牌具备足够熵——租约令牌是一次性凭据，
 * 决定哪个 Agent 有权上报某个任务（产品设计第 7 节）。
 */
export const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * 协议信封。
 *
 * @typeParam TType - 消息类型字面量，作为判别属性。
 * @typeParam TPayload - 与 `TType` 静态对应的负载类型。
 */
export interface ProtocolEnvelope<TType extends string, TPayload> {
  /**
   * 消息唯一标识。
   *
   * 同时充当幂等键：接收方可用它去重，`task.claim` 等可能重发的消息依赖该语义。
   */
  readonly id: string;
  /** 消息类型，判别属性。 */
  readonly type: TType;
  /** 消息发出时间。 */
  readonly timestamp: IsoDateTimeString;
  /** 发送方使用的协议版本。 */
  readonly protocolVersion: SupportedProtocolVersion;
  /** 消息负载，结构由 `type` 唯一决定。 */
  readonly payload: TPayload;
}

/** 信封允许出现的属性，用于拒绝未知字段。 */
export const PROTOCOL_ENVELOPE_PROPERTIES = [
  'id',
  'type',
  'timestamp',
  'protocolVersion',
  'payload',
] as const;
