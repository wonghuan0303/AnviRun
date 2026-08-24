/**
 * 配置表单模板校验的错误码与问题结构。
 *
 * 错误码是稳定协议：Web 依据 `code` 展示提示、依据 `pointer` / `fieldIndex` 定位到
 * JSON 编辑器中的具体位置（见实施计划 T3.2「错误定位」）。新增错误码是兼容变更，
 * 重命名或删除属于破坏性变更。
 */

import {
  toJsonPointer,
  type ValidationIssue,
  type ValidationPathSegment,
} from '../validation/issue';

/** 表单模板校验错误码，顺序按“从整体到细节”排列。 */
export const FORM_SCHEMA_ISSUE_CODES = [
  /** 模板顶层不是数组。 */
  'SCHEMA_NOT_ARRAY',
  /** 数组元素不是对象。 */
  'FIELD_NOT_OBJECT',
  /** 缺少 `type`。 */
  'FIELD_TYPE_MISSING',
  /** `type` 不在控件白名单中（含任意组件名）。 */
  'FIELD_TYPE_UNKNOWN',
  /** 缺少 `name` 或 `name` 不是字符串。 */
  'FIELD_NAME_MISSING',
  /** `name` 不满足格式约束。 */
  'FIELD_NAME_INVALID',
  /** 同一模板内 `name` 重复。 */
  'FIELD_NAME_DUPLICATE',
  /** 缺少 `label` 或 `label` 不是字符串。 */
  'FIELD_LABEL_MISSING',
  /** `label` 为空白、含控制字符或含标签文本。 */
  'FIELD_LABEL_INVALID',
  /** 出现该控件不允许的属性（事件、组件名、插槽、未批准属性等）。 */
  'UNKNOWN_PROPERTY',
  /** 属性存在但类型错误。 */
  'PROPERTY_TYPE_INVALID',
  /** 单个约束自身非法，例如 `minLength` 为负、`step` 非正、`pattern` 无法编译。 */
  'CONSTRAINT_INVALID',
  /** 约束之间矛盾，例如 `minLength > maxLength`、`min > max`。 */
  'CONSTRAINT_RANGE_INVALID',
  /** `defaultValue` 类型与控件不匹配。 */
  'DEFAULT_VALUE_TYPE_INVALID',
  /** `defaultValue` 不在 `options` 声明的取值中。 */
  'DEFAULT_VALUE_NOT_ALLOWED',
  /** `defaultValue` 违反该字段自身的约束。 */
  'DEFAULT_VALUE_CONSTRAINT_VIOLATION',
  /** 带选项的控件缺少 `options`。 */
  'OPTIONS_MISSING',
  /** `options` 不是数组。 */
  'OPTIONS_NOT_ARRAY',
  /** `options` 为空数组。 */
  'OPTIONS_EMPTY',
  /** 单个选项不是对象。 */
  'OPTION_NOT_OBJECT',
  /** 选项含未知属性。 */
  'OPTION_UNKNOWN_PROPERTY',
  /** 选项 `label` 非法。 */
  'OPTION_LABEL_INVALID',
  /** 选项 `value` 非法。 */
  'OPTION_VALUE_INVALID',
  /** 选项 `value` 重复。 */
  'OPTION_VALUE_DUPLICATE',
  /** `password` 显式声明 `sensitive: false`。 */
  'SENSITIVE_REQUIRED',
] as const;

/** 表单模板校验错误码。 */
export type FormSchemaIssueCode = (typeof FORM_SCHEMA_ISSUE_CODES)[number];

/**
 * 一条表单模板校验问题。
 *
 * 在通用 {@link ValidationIssue} 之上补充定位信息：
 * - `fieldIndex`：出错字段在模板数组中的下标（模板整体错误时缺省）；
 * - `fieldName`：该字段的 `name`（`name` 本身缺失或非字符串时缺省）；
 * - `property`：出错的属性名（问题指向字段整体时缺省）。
 */
export interface FormSchemaIssue extends ValidationIssue<FormSchemaIssueCode> {
  readonly fieldIndex?: number;
  readonly fieldName?: string;
  readonly property?: string;
}

/** {@link createFormSchemaIssue} 的可选定位信息。 */
export interface FormSchemaIssueContext {
  readonly fieldIndex?: number;
  readonly fieldName?: string;
  readonly property?: string;
}

/** 构造一条表单模板校验问题，`pointer` 由 `path` 自动推导。 */
export function createFormSchemaIssue(
  code: FormSchemaIssueCode,
  path: readonly ValidationPathSegment[],
  message: string,
  context: FormSchemaIssueContext = {},
): FormSchemaIssue {
  return {
    code,
    path,
    pointer: toJsonPointer(path),
    message,
    ...(context.fieldIndex === undefined ? {} : { fieldIndex: context.fieldIndex }),
    ...(context.fieldName === undefined ? {} : { fieldName: context.fieldName }),
    ...(context.property === undefined ? {} : { property: context.property }),
  };
}
