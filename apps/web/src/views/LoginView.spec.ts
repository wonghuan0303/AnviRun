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

  it('lets ADMIN use the default administrator destination', async () => {
    await submitLogin();

    expect(mocks.auth.login).toHaveBeenCalledWith('user', 'secret');
    expect(mocks.replace).toHaveBeenCalledWith('/admin/agents');
  });

  it('sends a normal USER to projects by default', async () => {
    mocks.auth.isAdmin = false;
    await submitLogin();

    expect(mocks.replace).toHaveBeenCalledWith('/projects');
  });

  it('does not let USER reuse an administrator redirect', async () => {
    mocks.auth.isAdmin = false;
    mocks.route.query = { redirect: '/admin/agents' };
    await submitLogin();

    expect(mocks.replace).toHaveBeenCalledWith('/projects');
  });

  it('lets ADMIN use an administrator redirect', async () => {
    mocks.route.query = { redirect: '/admin/agents' };
    await submitLogin();

    expect(mocks.replace).toHaveBeenCalledWith('/admin/agents');
  });
});
