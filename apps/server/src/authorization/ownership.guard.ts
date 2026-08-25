import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { AuthorizationService } from './authorization.service';
import { OWNED_RESOURCE_METADATA, type OwnedResourceMetadata } from './owned-resource.decorator';

/**
 * Checks explicit @OwnedResource metadata after AccessTokenGuard has populated
 * request.user. A missing user intentionally retains the existing auth error.
 */
@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<OwnedResourceMetadata>(
      OWNED_RESOURCE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!metadata) return true;

    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { params?: Record<string, string | undefined> }>();
    const actor = request.user;
    if (!actor) throw new ApiException('AUTH_TOKEN_EXPIRED');
    const resourceId = request.params?.[metadata.paramName] ?? '';

    switch (metadata.kind) {
      case 'project':
        await this.authorization.assertProjectAccess(actor, resourceId);
        break;
      case 'task':
        await this.authorization.assertTaskAccess(actor, resourceId);
        break;
      case 'taskLog':
        await this.authorization.assertTaskLogAccess(actor, resourceId);
        break;
      case 'artifact':
        await this.authorization.assertArtifactAccess(actor, resourceId);
        break;
      default:
        throw new ApiException('RESOURCE_NOT_FOUND');
    }

    return true;
  }
}
