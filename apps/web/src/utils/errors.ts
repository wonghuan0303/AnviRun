import { ApiError } from '@/api/client';
import type { FormConfigIssue, FormConfigIssueCode } from '@anvilrun/contracts';

const messages: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: '用户名或密码错误',
  AUTH_TOKEN_EXPIRED: '登录状态已过期，请重新登录',
  AUTH_ACCOUNT_DISABLED: '账号已被禁用',
  FORBIDDEN: '没有执行该操作的权限',
  RESOURCE_NOT_FOUND: '资源不存在或已不可用',
  AGENT_DISABLED: '目标 Agent 已停用',
  AGENT_OFFLINE: '目标 Agent 当前离线',
  BUILD_TEMPLATE_INVALID: '构建模板不合法或仍被其他资源引用',
  PROJECT_CONFIG_INVALID: '项目配置不合法，请检查具体字段',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathValue(value: unknown): readonly (string | number)[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (segment): segment is string | number =>
      typeof segment === 'string' || (typeof segment === 'number' && Number.isInteger(segment)),
  );
}

export function formConfigIssues(error: unknown): readonly FormConfigIssue[] {
  const issues = errorDetails(error)?.issues;
  if (!Array.isArray(issues)) return [];

  return issues.filter(isRecord).flatMap((issue) => {
    if (typeof issue.code !== 'string' || typeof issue.message !== 'string') return [];
    const fieldName = typeof issue.fieldName === 'string' ? issue.fieldName : undefined;
    const expected = typeof issue.expected === 'string' ? issue.expected : undefined;
    const actual = typeof issue.actual === 'string' ? issue.actual : undefined;
    return [
      {
        code: issue.code as FormConfigIssueCode,
        message: issue.message,
        path: pathValue(issue.path),
        pointer: typeof issue.pointer === 'string' ? issue.pointer : '',
        ...(fieldName === undefined ? {} : { fieldName }),
        ...(expected === undefined ? {} : { expected }),
        ...(actual === undefined ? {} : { actual }),
      },
    ];
  });
}
