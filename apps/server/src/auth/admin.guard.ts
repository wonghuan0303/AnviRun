import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { ApiException } from '../common/api-exception';
import type { AuthenticatedRequest } from './auth.types';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user?.role !== 'ADMIN') throw new ApiException('FORBIDDEN');
    return true;
  }
}
