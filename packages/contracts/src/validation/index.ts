/** 契约校验的公共结构与原子谓词。 */

export {
  ContractValidationError,
  ROOT_POINTER_LABEL,
  createIssue,
  formatValidationIssues,
  toJsonPointer,
} from './issue';
export type {
  ValidationFailure,
  ValidationIssue,
  ValidationPathSegment,
  ValidationResult,
  ValidationSuccess,
} from './issue';

export {
  containsControlCharacters,
  describeToken,
  describeValueType,
  findUnknownProperties,
  isBoolean,
  isCalendarDateString,
  isFiniteNumber,
  isInteger,
  isIso8601UtcString,
  isNonEmptyPlainText,
  isNonNegativeInteger,
  isPlainObject,
  isPlainText,
  isString,
  looksLikeMarkup,
} from './primitives';

export { isMemberOf, parseEnumValue } from './enum';
export type { EnumParseOptions } from './enum';
