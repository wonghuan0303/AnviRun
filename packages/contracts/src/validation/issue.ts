/**
 * 契约包内所有运行时校验器共享的问题（issue）与结果结构。
 *
 * 设计目标：Server 与 Web 拿到同一份校验结果后，能够
 * 1. 用稳定的 `code` 做分支判断与国际化，不依赖 `message` 文案；
 * 2. 用 `path` / `pointer` 精确定位到出错的数组下标与属性名。
 */

/** 校验路径片段：数字表示数组下标，字符串表示对象属性名。 */
export type ValidationPathSegment = string | number;

/** 单条校验问题。`TCode` 由各领域收窄为自己的稳定错误码联合。 */
export interface ValidationIssue<TCode extends string = string> {
  /** 稳定错误码，调用方应据此分支，而不是解析 `message`。 */
  readonly code: TCode;
  /** 结构化路径，例如 `[0, 'options', 1, 'value']`。 */
  readonly path: readonly ValidationPathSegment[];
  /** `path` 的 RFC 6901 JSON Pointer 形式，例如 `/0/options/1/value`。 */
  readonly pointer: string;
  /** 面向开发者的可读描述，不做国际化承诺。 */
  readonly message: string;
}

/** 校验成功结果。 */
export interface ValidationSuccess<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

/** 校验失败结果。`issues` 至少包含一条，且顺序稳定。 */
export interface ValidationFailure<TCode extends string = string> {
  readonly ok: false;
  readonly issues: readonly ValidationIssue<TCode>[];
}

/** 校验结果判别联合。 */
export type ValidationResult<TValue, TCode extends string = string> =
  ValidationSuccess<TValue> | ValidationFailure<TCode>;

/**
 * 将结构化路径转换为 RFC 6901 JSON Pointer。
 *
 * 根路径返回空字符串；`~` 与 `/` 按规范转义为 `~0` 与 `~1`。
 */
export function toJsonPointer(path: readonly ValidationPathSegment[]): string {
  return path
    .map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`)
    .join('');
}

/** 根路径在可读输出中的占位符。 */
export const ROOT_POINTER_LABEL = '(root)';

/** 构造一条基础校验问题，`pointer` 由 `path` 自动推导。 */
export function createIssue<TCode extends string>(
  code: TCode,
  path: readonly ValidationPathSegment[],
  message: string,
): ValidationIssue<TCode> {
  return { code, path, pointer: toJsonPointer(path), message };
}

/**
 * 把校验问题格式化为稳定、可读的多行文本，每行一条：
 *
 * ```text
 * /0/name [NAME_INVALID_FORMAT] name 不满足 [A-Za-z_][A-Za-z0-9_.-]{0,63}
 * ```
 */
export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map(
      (issue) =>
        `${issue.pointer === '' ? ROOT_POINTER_LABEL : issue.pointer} [${issue.code}] ${issue.message}`,
    )
    .join('\n');
}

/** 校验失败时抛出的错误，`issues` 保留完整定位信息。 */
export class ContractValidationError<TCode extends string = string> extends Error {
  /** 触发失败的全部问题，顺序与校验器返回一致。 */
  readonly issues: readonly ValidationIssue<TCode>[];

  constructor(summary: string, issues: readonly ValidationIssue<TCode>[]) {
    super(`${summary}\n${formatValidationIssues(issues)}`);
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}
