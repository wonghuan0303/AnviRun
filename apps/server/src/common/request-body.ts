import { createApiErrorResponse } from '@anvilrun/contracts';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { MAX_JSON_BODY_BYTES, MAX_URLENCODED_BODY_BYTES } from './security-limits';

function requestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function isBodyParserError(error: unknown): error is { type?: unknown } {
  return typeof error === 'object' && error !== null;
}

function handleBodyParserError(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!isBodyParserError(error)) {
    next(error);
    return;
  }
  if (error.type === 'entity.too.large') {
    response.status(413).json(
      createApiErrorResponse('VALIDATION_FAILED', {
        message: '请求体超过允许大小',
        requestId: requestId(request),
      }),
    );
    return;
  }
  if (error.type === 'entity.parse.failed') {
    response.status(400).json(
      createApiErrorResponse('VALIDATION_FAILED', {
        message: '请求体格式无效',
        requestId: requestId(request),
      }),
    );
    return;
  }
  next(error);
}

export function configureRequestBodyLimits(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: MAX_JSON_BODY_BYTES });
  app.useBodyParser('urlencoded', { limit: MAX_URLENCODED_BODY_BYTES, extended: true });
  app.use(handleBodyParserError);
}
