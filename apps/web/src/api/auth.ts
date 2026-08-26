import { apiRequest } from './client';
import type { AuthResponse, AuthUser } from './types';

export function login(username: string, password: string): Promise<AuthResponse> {
  return apiRequest<AuthResponse>('/auth/login', {
    method: 'POST',
    body: { username, password },
    skipRefresh: true,
  });
}

export function refresh(): Promise<AuthResponse> {
  return apiRequest<AuthResponse>('/auth/refresh', { method: 'POST', skipRefresh: true });
}

export function logout(): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>('/auth/logout', { method: 'POST', skipRefresh: true });
}

export function me(): Promise<AuthUser> {
  return apiRequest<AuthUser>('/auth/me');
}
