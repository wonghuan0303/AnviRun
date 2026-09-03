import {
  getApiErrorDefaultMessage,
  getApiErrorHttpStatus,
  type ApiErrorCode,
  type ApiErrorDetails,
} from '@anvilrun/contracts';
import { HttpException } from '@nestjs/common';

/** 内部业务异常：由统一过滤器转换为公共 API 错误契约。 */
export class ApiException extends HttpException {
  readonly code: ApiErrorCode;
  readonly details?: ApiErrorDetails;

  constructor(
    code: ApiErrorCode,
    options: { message?: string; details?: ApiErrorDetails; status?: number } = {},
  ) {
    super(
      options.message ?? getApiErrorDefaultMessage(code),
      options.status ?? getApiErrorHttpStatus(code),
    );
    this.code = code;
    this.details = options.details;
  }
}
