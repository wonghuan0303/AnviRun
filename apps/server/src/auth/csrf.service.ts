import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { ApiException } from '../common/api-exception';
import { CookieService } from './cookie.service';

@Injectable()
export class CsrfService {
  constructor(private readonly cookies: CookieService) {}

  assertValid(
    request: { headers?: Record<string, string | string[] | undefined> },
    allowEmpty = false,
  ): void {
    const csrfCookie = this.cookies.getCsrfCookie(request);
    const headerValue = request.headers?.['x-csrf-token'];
    const csrfHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (allowEmpty && !csrfCookie && !csrfHeader) return;
    if (!csrfCookie || !csrfHeader || !this.constantTimeEqual(csrfCookie, csrfHeader)) {
      throw new ApiException('AUTH_INVALID_CREDENTIALS', { message: '认证请求无效' });
    }
  }

  private constantTimeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
