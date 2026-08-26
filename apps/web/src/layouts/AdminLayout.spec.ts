import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import AdminLayout from './AdminLayout.vue';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  auth: { user: { username: 'admin', role: 'ADMIN' }, logout: vi.fn() },
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/admin/agents', meta: { title: 'Agent 管理' } }),
  useRouter: () => ({ replace: mocks.replace }),
  RouterView: { template: '<div />' },
}));

describe('AdminLayout', () => {
  it('shows administrator navigation and current role', () => {
    const wrapper = mount(AdminLayout, {
      global: { plugins: [ElementPlus], stubs: { RouterView: { template: '<div />' } } },
    });

    expect(wrapper.text()).toContain('Agent 管理');
    expect(wrapper.text()).toContain('构建模板');
    expect(wrapper.text()).toContain('admin（ADMIN）');
  });
});
