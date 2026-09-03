import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import LoginView from './LoginView.vue';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  route: { query: {} as Record<string, string> },
  auth: { login: vi.fn(), isAdmin: true },
}));

vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
}));

async function submitLogin(): Promise<void> {
  const wrapper = mount(LoginView, { global: { plugins: [ElementPlus] } });
  const inputs = wrapper.findAll('input');
  await inputs[0].setValue(' user ');
  await inputs[1].setValue('secret');
  await wrapper.find('form').trigger('submit');
  await flushPromises();
}

describe('LoginView', () => {
  beforeEach(() => {
    mocks.replace.mockReset();
    mocks.auth.login.mockReset();
    mocks.auth.login.mockResolvedValue(undefined);
    mocks.auth.isAdmin = true;
    mocks.route.query = {};
  });

  it('sends ADMIN to overview by default', async () => {
    await submitLogin();

    expect(mocks.auth.login).toHaveBeenCalledWith('user', 'secret');
    expect(mocks.replace).toHaveBeenCalledWith('/overview');
  });

  it('sends a normal USER to overview by default', async () => {
    mocks.auth.isAdmin = false;
    await submitLogin();

    expect(mocks.replace).toHaveBeenCalledWith('/overview');
  });

  it('does not let USER reuse an administrator redirect', async () => {
    mocks.auth.isAdmin = false;
    mocks.route.query = { redirect: '/admin/agents' };
    await submitLogin();

    expect(mocks.replace).toHaveBeenCalledWith('/overview');
  });

  it('lets ADMIN use an administrator redirect', async () => {
    mocks.route.query = { redirect: '/admin/agents' };
    await submitLogin();

    expect(mocks.replace).toHaveBeenCalledWith('/admin/agents');
  });
  it('allows USER project redirects and task redirects', async () => {
    mocks.auth.isAdmin = false;
    mocks.route.query = { redirect: '/projects/project-id' };
    await submitLogin();
    expect(mocks.replace).toHaveBeenCalledWith('/projects/project-id');

    mocks.replace.mockReset();
    mocks.route.query = { redirect: '/tasks/123e4567-e89b-12d3-a456-426614174000' };
    await submitLogin();
    expect(mocks.replace).toHaveBeenCalledWith('/tasks/123e4567-e89b-12d3-a456-426614174000');
  });
});
