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

    expect(router.currentRoute.value.name).toBe('overview');
  });

  it('allows ADMIN into administrator routes', async () => {
    vi.mocked(authApi.refresh).mockResolvedValue(session(admin));

    await router.push('/admin/agents');

    expect(router.currentRoute.value.name).toBe('admin-agents');
  });

  it('protects the user management route with the administrator guard', async () => {
    vi.mocked(authApi.refresh).mockResolvedValue(session(user));

    await router.push('/admin/users');
    expect(router.currentRoute.value.name).toBe('overview');

    setActivePinia(createPinia());
    vi.mocked(authApi.refresh).mockResolvedValue(session(admin));
    await router.push('/admin/users');
    expect(router.currentRoute.value.name).toBe('admin-users');
  });

  it('redirects an authenticated user from login to overview', async () => {
    vi.mocked(authApi.refresh).mockResolvedValue(session(user));

    await router.push('/login');

    expect(router.currentRoute.value.name).toBe('overview');
  });

  it('allows both authenticated roles into project task routes', async () => {
    vi.mocked(authApi.refresh).mockResolvedValue(session(user));
    await router.push('/projects/project-id/tasks');
    expect(router.currentRoute.value.name).toBe('project-tasks');

    setActivePinia(createPinia());
    vi.mocked(authApi.refresh).mockResolvedValue(session(admin));
    await router.push('/tasks/task-id');
    expect(router.currentRoute.value.name).toBe('task-detail');
  });

  it('uses the revised project route titles', () => {
    expect(router.getRoutes().find((route) => route.name === 'project-edit')?.meta.title).toBe(
      '编辑基本信息',
    );
    expect(router.getRoutes().find((route) => route.name === 'project-config')?.meta.title).toBe(
      '参数配置',
    );
  });
});
