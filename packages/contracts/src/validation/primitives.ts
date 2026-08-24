/**
 * 契约校验使用的原子谓词。
 *
 * 这些函数被表单模板校验器与 WebSocket 协议校验器共用，
 * 因此规则必须与 Rust 侧 `build-agent-contracts` 中的同名实现保持一致。
 */

/** 判断是否为普通对象（排除 `null`、数组与其它内建对象包装）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断是否为字符串。 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** 判断是否为布尔值。 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** 判断是否为有限数字（拒绝 `NaN`、`Infinity`）。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 判断是否为安全范围内的整数。 */
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** 判断是否为非负整数。 */
export function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

/**
 * 判断字符串是否包含控制字符或行分隔符。
 *
 * 覆盖 C0（`U+0000`–`U+001F`）、DEL 与 C1（`U+007F`–`U+009F`）
 * 以及 `U+2028` / `U+2029`。这些字符会破坏日志、CSV 导出与前端渲染。
 */
export function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }

  return false;
}

/**
 * 判断字符串是否看起来包含 HTML / XML 标签。
 *
 * 只在 `<` 紧跟标签起始字符时判定为标签，因此
 * `宽度 > 100`、`a < b` 属于合法纯文本，而 `<b>`、`</b>`、`<!--`、`<img ...>` 被拒绝。
 */
export function looksLikeMarkup(value: string): boolean {
  return /<[/!?a-zA-Z]/.test(value);
}

/** 判断是否为非空纯文本：字符串、无控制字符、不含标签。 */
export function isPlainText(value: unknown): value is string {
  return isString(value) && !containsControlCharacters(value) && !looksLikeMarkup(value);
}

/** 判断是否为去除首尾空白后仍非空的纯文本。 */
export function isNonEmptyPlainText(value: unknown): value is string {
  return isPlainText(value) && value.trim().length > 0;
}

/** ISO 8601 UTC 时间戳的词法形式：`YYYY-MM-DDTHH:MM:SS[.f{1,9}]Z`。 */
const ISO_8601_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** 纯日期的词法形式：`YYYY-MM-DD`。 */
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/**
 * 判断是否为 `YYYY-MM-DD` 纯日期字符串，并校验日历有效性（含闰年）。
 *
 * `date` 控件的值使用该格式（产品设计 6.2「ISO 日期字符串」）。
 */
export function isCalendarDateString(value: unknown): value is string {
  if (!isString(value)) {
    return false;
  }

  const matched = CALENDAR_DATE_PATTERN.exec(value);

  if (matched === null) {
    return false;
  }

  return isValidCalendarDate(Number(matched[1]), Number(matched[2]), Number(matched[3]));
}

/**
 * 判断是否为协议约定的 ISO 8601 UTC 时间戳字符串。
 *
 * 约定（Server、Web、Agent 三侧一致）：
 * - 必须是 `YYYY-MM-DDTHH:MM:SS[.f{1,9}]Z`，秒的小数部分可选、1–9 位；
 * - 必须以字面量 `Z` 结尾，不接受 `+08:00` 等偏移量，也不接受省略时区；
 * - 校验日历有效性（含闰年），因此 `2026-02-30T00:00:00Z` 会被拒绝；
 * - 不接受闰秒（秒最大 59）。
 */
export function isIso8601UtcString(value: unknown): value is string {
  if (!isString(value)) {
    return false;
  }

  const matched = ISO_8601_UTC_PATTERN.exec(value);

  if (matched === null) {
    return false;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const hour = Number(matched[4]);
  const minute = Number(matched[5]);
  const second = Number(matched[6]);

  if (!isValidCalendarDate(year, month, day)) {
    return false;
  }

  return hour <= 23 && minute <= 59 && second <= 59;
}

/** 返回对象上不属于允许集合的属性名，顺序与 `Object.keys` 一致。 */
export function findUnknownProperties(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);

  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

/**
 * 描述值的“形状”，用于拼接错误信息。
 *
 * 只输出类型与长度，**绝不回显内容**，避免默认值、配置值等敏感数据进入
 * 错误响应、日志或前端提示。
 */
export function describeValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (Array.isArray(value)) {
    return `array(length=${value.length})`;
  }

  if (typeof value === 'string') {
    return `string(length=${value.length})`;
  }

  if (typeof value === 'object') {
    return 'object';
  }

  return typeof value;
}

/** 单个判别/枚举取值在错误信息中允许回显的最大长度。 */
const TOKEN_ECHO_LIMIT = 64;

/**
 * 描述判别字段（`type`、`status`、`stream` 等协议令牌）的实际取值。
 *
 * 这些位置的合法取值是公开的协议常量，回显有助于定位问题；
 * 超长字符串仍退化为形状描述，防止把大段负载写进日志。
 */
export function describeToken(value: unknown): string {
  if (isString(value) && value.length <= TOKEN_ECHO_LIMIT && !containsControlCharacters(value)) {
    return JSON.stringify(value);
  }

  return describeValueType(value);
}
