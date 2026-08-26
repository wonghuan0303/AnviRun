import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import type { AuthResponse, AuthUser } from '@/api/types';
import * as authApi from '@/api/auth';
import { useAuthStore } from './auth';

vi.mock('@/api/auth', () => ({
  login: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}));

const admin: AuthUser = { id: 'admin-id', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
const user: AuthUser = { id: 'user-id', username: 'user', role: 'USER', status: 'ACTIVE' };
const session = (nextUser: AuthUser): AuthResponse => ({
  accessToken: `${nextUser.username}-token`,
  user: nextUser,
});

describe('auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(authApi.login).mockReset();
    vi.mocked(authApi.refresh).mockReset();
    vi.mocked(authApi.logout).mockReset();
  });

  it('keeps the access token in memory and exposes the user role', async () => {
    vi.mocked(authApi.login).mockResolvedValue(session(admin));
    const store = useAuthStore();

    await store.login('admin', 'password');

    expect(store.accessToken).toBe('admin-token');
    expect(store.user).toEqual(admin);
    expect(store.isAdmin).toBe(true);
  });

  it('clears the session when refresh fails', async () => {
    vi.mocked(authApi.refresh).mockRejectedValue(new Error('expired'));
    const store = useAuthStore();
    store.clearSession();

    await expect(store.refreshSession()).resolves.toBe(false);
    expect(store.isAuthenticated).toBe(false);
  });

  it('does not treat a normal user as an administrator', async () => {
    vi.mocked(authApi.login).mockResolvedValue(session(user));
    const store = useAuthStore();

    await store.login('user', 'password');

    expect(store.isAdmin).toBe(false);
  });
});
