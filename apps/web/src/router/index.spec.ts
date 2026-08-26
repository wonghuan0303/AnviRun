import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import type { AuthResponse, AuthUser } from '@/api/types';
import * as authApi from '@/api/auth';
import { router } from './index';

vi.mock('@/api/auth', () => ({
  login: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}));

const admin: AuthUser = { id: 'admin-id', username: 'admin', role: 'ADMIN', status: 'ACTIVE' };
const user: AuthUser = { id: 'user-id', username: 'user', role: 'USER', status: 'ACTIVE' };
const session = (nextUser: AuthUser): AuthResponse => ({ accessToken: 'token', user: nextUser });

describe('router authorization guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(authApi.refresh).mockReset();
  });

  it('redirects an unauthenticated administrator route to login', async () => {
    vi.mocked(authApi.refresh).mockRejectedValue(new Error('no session'));

    await router.push('/admin/agents');

    expect(router.currentRoute.value.name).toBe('login');
  }, 60_000);

  it('keeps USER out of administrator routes', async () => {
    vi.mocked(authApi.refresh).mockResolvedValue(session(user));

    await router.push('/admin/agents');

    expect(router.currentRoute.value.name).toBe('projects');
  });

  it('allows ADMIN into administrator routes', async () => {
    vi.mocked(authApi.refresh).mockResolvedValue(session(admin));

    await router.push('/admin/agents');

    expect(router.currentRoute.value.name).toBe('admin-agents');
  });
});
