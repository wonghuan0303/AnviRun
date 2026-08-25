import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest, AuthenticatedRequestUser } from './auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedRequestUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user as AuthenticatedRequestUser;
  },
);
