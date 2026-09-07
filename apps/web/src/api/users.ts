import { apiRequest } from './client';
import type { AdminUser, AdminUserListParams, AdminUserPage, AuthUser, UserRole } from './types';

export function listAdminUsers(params: AdminUserListParams = {}): Promise<AdminUserPage> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  if (params.search) query.set('search', params.search);
  if (params.role) query.set('role', params.role);
  if (params.status) query.set('status', params.status);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<AdminUserPage>(`/admin/users${suffix}`);
}

export function createAdminUser(input: {
  username: string;
  password: string;
  role: UserRole;
}): Promise<AuthUser> {
  return apiRequest<AuthUser>('/admin/users', { method: 'POST', body: input });
}

export function enableAdminUser(id: string): Promise<AuthUser> {
  return apiRequest<AuthUser>(`/admin/users/${id}/enable`, { method: 'POST' });
}

export function disableAdminUser(id: string): Promise<AuthUser> {
  return apiRequest<AuthUser>(`/admin/users/${id}/disable`, { method: 'PATCH' });
}

export function resetAdminUserPassword(id: string, password: string): Promise<AuthUser> {
  return apiRequest<AuthUser>(`/admin/users/${id}/reset-password`, {
    method: 'POST',
    body: { password },
  });
}

export type { AdminUser };
