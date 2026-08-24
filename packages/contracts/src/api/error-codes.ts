/**
 * REST API 稳定业务错误码（产品设计第 10 节、第 12 节）。
 *
 * 这些字符串是**协议的一部分**：Web 依赖它们决定提示文案与跳转逻辑，
 * 删除或重命名任一错误码都属于破坏性变更（见 `packages/contracts/README.md`）。
 */

/** 全部业务错误码，顺序稳定。 */
export const API_ERROR_CODES = [
  /** 用户名或密码错误。不区分“用户不存在”与“密码错误”，避免账号枚举。 */
  'AUTH_INVALID_CREDENTIALS',
  /** 访问令牌过期或签名无效，客户端应重新登录。 */
  'AUTH_TOKEN_EXPIRED',
  /** 账号被管理员禁用。 */
  'AUTH_ACCOUNT_DISABLED',
  /** 已登录但权限不足，例如普通用户访问管理端接口。 */
  'FORBIDDEN',
  /** 请求参数校验失败。`details` 可携带字段级问题列表。 */
  'VALIDATION_FAILED',
  /** 目标资源不存在，或当前用户无权感知其存在。 */
  'RESOURCE_NOT_FOUND',
  /** 目标 Agent 当前离线，无法承接构建任务。 */
  'AGENT_OFFLINE',
  /** 目标 Agent 已被禁用。 */
  'AGENT_DISABLED',
  /** 构建模板非法：配置表单模板或构建命令不合规。 */
  'BUILD_TEMPLATE_INVALID',
  /** 项目配置非法：配置值与模板不匹配。 */
  'PROJECT_CONFIG_INVALID',
  /** 任务当前状态不允许该操作，例如取消已完成的任务。 */
  'TASK_INVALID_STATE',
  /** 任务租约无效、已过期或已被其它 Agent 领取。 */
  'TASK_LEASE_INVALID',
  /** 产物路径非法，例如越出产物目录或包含路径穿越。 */
  'ARTIFACT_INVALID_PATH',
  /** 产物大小超过平台限制。 */
  'ARTIFACT_SIZE_LIMIT_EXCEEDED',
] as const;

/** 业务错误码。 */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 判断是否为已知业务错误码。 */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 业务错误码到 HTTP 状态码的约定映射。
 *
 * Server 侧异常过滤器（T1.1）据此设置响应状态码；Web 只依赖 `code`，
 * 不应根据状态码推断业务语义。
 */
export const API_ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_ACCOUNT_DISABLED: 403,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  RESOURCE_NOT_FOUND: 404,
  AGENT_OFFLINE: 409,
  AGENT_DISABLED: 409,
  BUILD_TEMPLATE_INVALID: 400,
  PROJECT_CONFIG_INVALID: 400,
  TASK_INVALID_STATE: 409,
  TASK_LEASE_INVALID: 403,
  ARTIFACT_INVALID_PATH: 400,
  ARTIFACT_SIZE_LIMIT_EXCEEDED: 413,
};

/**
 * 各错误码的默认中文提示。
 *
 * 这是兜底文案：不得包含内部实现细节、SQL、堆栈或路径。
 * 调用方可以覆盖 `message`，但仍需遵守同样的约束。
 */
export const API_ERROR_DEFAULT_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  AUTH_INVALID_CREDENTIALS: '用户名或密码错误',
  AUTH_TOKEN_EXPIRED: '登录状态已过期，请重新登录',
  AUTH_ACCOUNT_DISABLED: '账号已被禁用',
  FORBIDDEN: '没有执行该操作的权限',
  VALIDATION_FAILED: '请求参数校验失败',
  RESOURCE_NOT_FOUND: '资源不存在',
  AGENT_OFFLINE: '目标 Agent 当前离线',
  AGENT_DISABLED: '目标 Agent 已被禁用',
  BUILD_TEMPLATE_INVALID: '构建模板不合法',
  PROJECT_CONFIG_INVALID: '项目配置不合法',
  TASK_INVALID_STATE: '任务当前状态不允许该操作',
  TASK_LEASE_INVALID: '任务租约无效或已过期',
  ARTIFACT_INVALID_PATH: '产物路径不合法',
  ARTIFACT_SIZE_LIMIT_EXCEEDED: '产物大小超过平台限制',
};

/** 返回错误码对应的 HTTP 状态码。 */
export function getApiErrorHttpStatus(code: ApiErrorCode): number {
  return API_ERROR_HTTP_STATUS[code];
}

/** 返回错误码对应的默认提示文案。 */
export function getApiErrorDefaultMessage(code: ApiErrorCode): string {
  return API_ERROR_DEFAULT_MESSAGES[code];
}
