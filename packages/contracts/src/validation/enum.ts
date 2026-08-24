/**
 * 字符串字面量枚举的公共运行时校验工具。
 *
 * 契约包统一使用 `as const` 元组 + 索引类型来表达枚举，不使用 TypeScript `enum`：
 * 元组既是运行时白名单，又能推导出字面量联合类型，且在 CJS / ESM 两种产物下行为一致。
 */

import { ContractValidationError, createIssue } from './issue';
import { describeToken, isString } from './primitives';

/** 判断值是否属于给定字面量白名单。 */
export function isMemberOf<TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
): value is TValue {
  return isString(value) && (allowed as readonly string[]).includes(value);
}

/** `parseEnumValue` 的错误描述参数。 */
export interface EnumParseOptions {
  /** 稳定错误码，例如 `USER_ROLE_INVALID`。 */
  readonly code: string;
  /** 人类可读的契约名称，例如 `UserRole`。 */
  readonly label: string;
}

/**
 * 校验并返回枚举值，失败时抛出 {@link ContractValidationError}。
 *
 * 需要非抛出语义时改用 {@link isMemberOf}。
 */
export function parseEnumValue<TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
  options: EnumParseOptions,
): TValue {
  if (isMemberOf(allowed, value)) {
    return value;
  }

  throw new ContractValidationError(`${options.label} 校验失败`, [
    createIssue(
      options.code,
      [],
      `期望取值属于 [${allowed.join(', ')}]，实际收到 ${describeToken(value)}`,
    ),
  ]);
}
