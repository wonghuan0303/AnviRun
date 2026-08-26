import { ApiError } from '@/api/client';

const messages: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: '用户名或密码错误',
  AUTH_TOKEN_EXPIRED: '登录状态已过期，请重新登录',
  AUTH_ACCOUNT_DISABLED: '账号已被禁用',
  FORBIDDEN: '没有执行该操作的权限',
  RESOURCE_NOT_FOUND: '资源不存在或已不可用',
  AGENT_DISABLED: '目标 Agent 已停用',
  AGENT_OFFLINE: '目标 Agent 当前离线',
  BUILD_TEMPLATE_INVALID: '构建模板不合法或仍被其他资源引用',
  VALIDATION_FAILED: '请求参数校验失败',
};

export function errorMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof ApiError) return messages[error.code] ?? error.message ?? fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function errorDetails(error: unknown): Record<string, unknown> | undefined {
  return error instanceof ApiError ? error.details : undefined;
}
