import type { UserRole, UserStatus } from '@prisma/client';

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
}

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  tokenVersion: number;
  jti: string;
  typ: 'access';
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface AuthenticatedRequestUser extends PublicUser {
  tokenVersion: number;
  jti: string;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedRequestUser;
  ip?: string;
  socket?: { remoteAddress?: string };
  get?: (name: string) => string | undefined;
  header?: (name: string) => string | undefined;
}
