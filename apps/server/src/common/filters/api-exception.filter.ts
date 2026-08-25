import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { createApiErrorResponse, isApiErrorCode } from '@buildplatform/contracts';
import type { Request, Response } from 'express';

import { ApiException } from '../api-exception';

function safeRequestId(request: Request): string | undefined {
  const candidate = request.header('x-request-id');

  return candidate && /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate) ? candidate : undefined;
}

/** 把所有 Controller/Prisma 异常收敛为不泄露内部细节的 API 错误。 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const requestId = safeRequestId(request);

    if (exception instanceof ApiException) {
      response.status(exception.getStatus()).json(
        createApiErrorResponse(exception.code, {
          message: exception.message,
          details: exception.details,
          requestId,
        }),
      );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      const code =
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null &&
        'code' in exceptionResponse
          ? exceptionResponse.code
          : undefined;

      if (isApiErrorCode(code)) {
        response.status(status).json(createApiErrorResponse(code, { requestId }));
        return;
      }

      response.status(status).json(
        createApiErrorResponse(
          status === HttpStatus.FORBIDDEN ? 'FORBIDDEN' : 'VALIDATION_FAILED',
          {
            requestId,
          },
        ),
      );
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(
      createApiErrorResponse('VALIDATION_FAILED', {
        message: '请求无法处理，请稍后重试',
        requestId,
      }),
    );
  }
}
