import { SetMetadata } from '@nestjs/common';

export const OWNED_RESOURCE_METADATA = 'buildplatform:owned-resource';

export type OwnedResourceKind = 'project' | 'task' | 'taskLog' | 'artifact';

export interface OwnedResourceMetadata {
  readonly kind: OwnedResourceKind;
  readonly paramName: string;
}

export const OwnedResource = (kind: OwnedResourceKind, paramName: string) =>
  SetMetadata(OWNED_RESOURCE_METADATA, { kind, paramName } satisfies OwnedResourceMetadata);
