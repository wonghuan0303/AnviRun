/** REST API 错误契约。 */

export {
  API_ERROR_CODES,
  API_ERROR_DEFAULT_MESSAGES,
  API_ERROR_HTTP_STATUS,
  getApiErrorDefaultMessage,
  getApiErrorHttpStatus,
  isApiErrorCode,
} from './error-codes';
export type { ApiErrorCode } from './error-codes';

export {
  API_ERROR_DETAILS_MAX_DEPTH,
  API_ERROR_FORBIDDEN_DETAIL_KEYS,
  API_ERROR_ISSUE_CODES,
  API_ERROR_REQUEST_ID_PATTERN,
  createApiErrorResponse,
  isApiErrorResponse,
  isForbiddenDetailKey,
  looksLikeStackTrace,
  parseApiErrorResponse,
  validateApiErrorResponse,
} from './error-response';
export type {
  ApiErrorDetailValue,
  ApiErrorDetails,
  ApiErrorIssue,
  ApiErrorIssueCode,
  ApiErrorResponse,
  ApiErrorValidationFailure,
  ApiErrorValidationResult,
  CreateApiErrorResponseOptions,
} from './error-response';
