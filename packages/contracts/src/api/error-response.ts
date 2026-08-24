/**
 * 统一 REST API 错误响应结构。
 *
 * 产品设计第 10 节要求所有失败响应形状一致；第 12 节要求
 * **错误响应不得包含堆栈或敏感信息**。后一条不靠人工约定，而由
 * {@link validateApiErrorResponse} 强制：堆栈样式文本、敏感键名与控制字符都会被拒绝。
 */

import { API_ERROR_DEFAULT_MESSAGES, isApiErrorCode, type ApiErrorCode } from './error-codes';
import {
  ContractValidationError,
  createIssue,
  type ValidationIssue,
  type ValidationPathSegment,
  type ValidationSuccess,
} from '../validation/issue';
import {
  containsControlCharacters,
  describeToken,
  describeValueType,
  findUnknownProperties,
  isFiniteNumber,
  isNonEmptyPlainText,
  isPlainObject,
  isString,
} from '../validation/primitives';

/** `details` 允许承载的 JSON 值。 */
export type ApiErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly ApiErrorDetailValue[]
  | { readonly [key: string]: ApiErrorDetailValue };

/** `details` 的结构：字符串键到 JSON 值的映射。 */
export type ApiErrorDetails = Readonly<Record<string, ApiErrorDetailValue>>;

/**
 * 统一错误响应体。
 *
 * Web 只依赖 {@link ApiErrorResponse.code} 做分支判断，`message` 仅用于展示。
 */
export interface ApiErrorResponse {
  /** 稳定业务错误码。 */
  readonly code: ApiErrorCode;
  /** 面向用户的提示文案，非空纯文本。 */
  readonly message: string;
  /** 可选结构化补充信息，例如字段级校验问题列表。 */
  readonly details?: ApiErrorDetails;
  /** 可选请求标识，便于把前端报错与服务端日志对齐。 */
  readonly requestId?: string;
}

/** 错误响应自身的校验问题码。 */
export const API_ERROR_ISSUE_CODES = [
  /** 响应体不是普通对象。 */
  'RESPONSE_NOT_OBJECT',
  /** 出现约定之外的顶层属性。 */
  'UNKNOWN_PROPERTY',
  /** 缺少 `code`。 */
  'CODE_MISSING',
  /** `code` 不在已知错误码集合内。 */
  'CODE_UNKNOWN',
  /** `message` 缺失、为空、含控制字符或含标签。 */
  'MESSAGE_INVALID',
  /** `requestId` 不是安全格式的字符串。 */
  'REQUEST_ID_INVALID',
  /** `details` 或其内部值类型不合法。 */
  'DETAILS_INVALID',
  /** `details` 嵌套层级超过上限。 */
  'DETAILS_TOO_DEEP',
  /** 出现堆栈样式内容。 */
  'STACK_FORBIDDEN',
  /** 出现敏感键名。 */
  'SENSITIVE_KEY_FORBIDDEN',
] as const;

/** 错误响应自身的校验问题码。 */
export type ApiErrorIssueCode = (typeof API_ERROR_ISSUE_CODES)[number];

/** 错误响应校验问题。 */
export type ApiErrorIssue = ValidationIssue<ApiErrorIssueCode>;

/** 错误响应校验失败结果。 */
export interface ApiErrorValidationFailure {
  readonly ok: false;
  readonly issues: readonly ApiErrorIssue[];
}

/** 错误响应校验结果。 */
export type ApiErrorValidationResult =
  ValidationSuccess<ApiErrorResponse> | ApiErrorValidationFailure;

/** `requestId` 允许的字符集合：便于日志检索，且不会破坏日志格式。 */
export const API_ERROR_REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** `details` 允许的最大嵌套深度，`details` 自身记为第 1 层。 */
export const API_ERROR_DETAILS_MAX_DEPTH = 5;

/** 顶层允许的属性。 */
const ALLOWED_RESPONSE_PROPERTIES = ['code', 'message', 'details', 'requestId'] as const;

/**
 * 禁止出现在 `details` 中的键名（已归一化：小写并去掉 `_`、`-`、`.`、空格）。
 *
 * 归一化后 `Access-Token`、`access_token`、`accessToken` 都会命中同一条规则。
 */
export const API_ERROR_FORBIDDEN_DETAIL_KEYS: readonly string[] = [
  'stack',
  'stacktrace',
  'errorstack',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apisecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'leasetoken',
  'agenttoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'credential',
  'credentials',
  'privatekey',
  'sshkey',
  'sessionid',
];

const FORBIDDEN_DETAIL_KEY_SET = new Set(API_ERROR_FORBIDDEN_DETAIL_KEYS);

/**
 * 堆栈帧特征：`at fn (path:12:34)` 或 `path.ts:12:34`。
 *
 * 多行堆栈已经被“禁止控制字符”挡掉，这里补上被压成一行的情况。
 */
const STACK_FRAME_PATTERN = /(\bat\s+\S+\s*\()|(\.(?:[jt]s|rs|mjs|cjs):\d+:\d+)/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_.-]/g, '');
}

/** 判断键名是否属于禁止出现在错误响应中的敏感键。 */
export function isForbiddenDetailKey(key: string): boolean {
  return FORBIDDEN_DETAIL_KEY_SET.has(normalizeKey(key));
}

/** 判断文本是否包含堆栈帧特征。 */
export function looksLikeStackTrace(value: string): boolean {
  return STACK_FRAME_PATTERN.test(value);
}

function pushIssue(
  issues: ApiErrorIssue[],
  code: ApiErrorIssueCode,
  path: readonly ValidationPathSegment[],
  message: string,
): void {
  issues.push(createIssue<ApiErrorIssueCode>(code, path, message));
}

function validateDetailValue(
  value: unknown,
  path: readonly ValidationPathSegment[],
  depth: number,
  issues: ApiErrorIssue[],
): void {
  if (depth > API_ERROR_DETAILS_MAX_DEPTH) {
    pushIssue(
      issues,
      'DETAILS_TOO_DEEP',
      path,
      `details 嵌套层级超过上限 ${API_ERROR_DETAILS_MAX_DEPTH}`,
    );

    return;
  }

  if (value === null || typeof value === 'boolean') {
    return;
  }

  if (isString(value)) {
    if (containsControlCharacters(value)) {
      pushIssue(issues, 'STACK_FORBIDDEN', path, 'details 文本不得包含控制字符或换行（堆栈特征）');

      return;
    }

    if (looksLikeStackTrace(value)) {
      pushIssue(issues, 'STACK_FORBIDDEN', path, 'details 文本不得包含堆栈帧或源码位置');
    }

    return;
  }

  if (typeof value === 'number') {
    if (!isFiniteNumber(value)) {
      pushIssue(
        issues,
        'DETAILS_INVALID',
        path,
        'details 中的数字必须有限，不得为 NaN 或 Infinity',
      );
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateDetailValue(item, [...path, index], depth + 1, issues);
    });

    return;
  }

  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = [...path, key];

      if (isForbiddenDetailKey(key)) {
        pushIssue(
          issues,
          'SENSITIVE_KEY_FORBIDDEN',
          nestedPath,
          `details 不得包含敏感键名 ${JSON.stringify(key)}`,
        );

        continue;
      }

      validateDetailValue(nested, nestedPath, depth + 1, issues);
    }

    return;
  }

  pushIssue(
    issues,
    'DETAILS_INVALID',
    path,
    `details 只能承载 JSON 值，实际为 ${describeValueType(value)}`,
  );
}

/**
 * 校验统一错误响应体。
 *
 * 校验项：
 * 1. 顶层必须是对象，且只允许 `code`、`message`、`details`、`requestId`；
 * 2. `code` 必须是已知业务错误码；
 * 3. `message` 必须是非空纯文本，且不含堆栈特征；
 * 4. `requestId`（可选）必须匹配 {@link API_ERROR_REQUEST_ID_PATTERN}；
 * 5. `details`（可选）必须是对象，值限于 JSON 类型，深度不超过
 *    {@link API_ERROR_DETAILS_MAX_DEPTH}，键名不得命中
 *    {@link API_ERROR_FORBIDDEN_DETAIL_KEYS}，文本不得含控制字符或堆栈帧。
 *
 * Server（T1.1 异常过滤器）在返回前自检，Web 收到响应后可用同一函数判定协议合规。
 */
export function validateApiErrorResponse(input: unknown): ApiErrorValidationResult {
  const issues: ApiErrorIssue[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [
        createIssue<ApiErrorIssueCode>(
          'RESPONSE_NOT_OBJECT',
          [],
          `错误响应必须是对象，实际为 ${describeValueType(input)}`,
        ),
      ],
    };
  }

  const code = input['code'];

  if (code === undefined) {
    pushIssue(issues, 'CODE_MISSING', ['code'], '缺少 code');
  } else if (!isApiErrorCode(code)) {
    pushIssue(issues, 'CODE_UNKNOWN', ['code'], `未知业务错误码 ${describeToken(code)}`);
  }

  const message = input['message'];

  if (!isNonEmptyPlainText(message)) {
    pushIssue(
      issues,
      'MESSAGE_INVALID',
      ['message'],
      `message 必须是非空纯文本（无控制字符、无标签），实际为 ${describeValueType(message)}`,
    );
  } else if (looksLikeStackTrace(message)) {
    pushIssue(issues, 'STACK_FORBIDDEN', ['message'], 'message 不得包含堆栈帧或源码位置');
  }

  const requestId = input['requestId'];

  if (
    requestId !== undefined &&
    !(isString(requestId) && API_ERROR_REQUEST_ID_PATTERN.test(requestId))
  ) {
    pushIssue(
      issues,
      'REQUEST_ID_INVALID',
      ['requestId'],
      `requestId 必须匹配 ${API_ERROR_REQUEST_ID_PATTERN.source}，实际为 ${describeValueType(requestId)}`,
    );
  }

  const details = input['details'];

  if (details !== undefined) {
    if (!isPlainObject(details)) {
      pushIssue(
        issues,
        'DETAILS_INVALID',
        ['details'],
        `details 必须是对象，实际为 ${describeValueType(details)}`,
      );
    } else {
      validateDetailValue(details, ['details'], 1, issues);
    }
  }

  for (const key of findUnknownProperties(input, ALLOWED_RESPONSE_PROPERTIES)) {
    pushIssue(
      issues,
      'UNKNOWN_PROPERTY',
      [key],
      isForbiddenDetailKey(key)
        ? `错误响应不得包含敏感或堆栈属性 ${JSON.stringify(key)}`
        : `不允许的属性 ${JSON.stringify(key)}`,
    );
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: input as unknown as ApiErrorResponse };
}

/** 判断值是否为合法错误响应。 */
export function isApiErrorResponse(input: unknown): input is ApiErrorResponse {
  return validateApiErrorResponse(input).ok;
}

/** 解析错误响应，失败时抛出 {@link ContractValidationError}。 */
export function parseApiErrorResponse(input: unknown): ApiErrorResponse {
  const result = validateApiErrorResponse(input);

  if (!result.ok) {
    throw new ContractValidationError('API 错误响应校验失败', result.issues);
  }

  return result.value;
}

/** {@link createApiErrorResponse} 的可选参数。 */
export interface CreateApiErrorResponseOptions {
  /** 覆盖默认提示文案。必须仍是非空纯文本，不含堆栈或敏感信息。 */
  readonly message?: string;
  /** 结构化补充信息。 */
  readonly details?: ApiErrorDetails;
  /** 请求标识。 */
  readonly requestId?: string;
}

/**
 * 构造统一错误响应体。
 *
 * 只做组装，不抛异常：异常过滤器本身处于错误处理路径，不应再抛错。
 * 合规性由 {@link validateApiErrorResponse} 在测试与自检中保证。
 */
export function createApiErrorResponse(
  code: ApiErrorCode,
  options: CreateApiErrorResponseOptions = {},
): ApiErrorResponse {
  return {
    code,
    message: options.message ?? API_ERROR_DEFAULT_MESSAGES[code],
    ...(options.details !== undefined ? { details: options.details } : {}),
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
  };
}
