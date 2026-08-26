import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import LoginView from './LoginView.vue';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  auth: { login: vi.fn(), isAdmin: true },
}));

vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: mocks.replace }),
}));

describe('LoginView', () => {
  it('logs in and navigates to the administrator page', async () => {
    mocks.auth.login.mockResolvedValue(undefined);
    const wrapper = mount(LoginView, { global: { plugins: [ElementPlus] } });
    const inputs = wrapper.findAll('input');
    await inputs[0].setValue(' admin ');
    await inputs[1].setValue('secret');
    await wrapper.find('form').trigger('submit');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.auth.login).toHaveBeenCalledWith('admin', 'secret');
    expect(mocks.replace).toHaveBeenCalledWith('/admin/agents');
  });
});
