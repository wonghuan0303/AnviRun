import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import AppLayout from './AppLayout.vue';

const mocks = vi.hoisted(() => ({
  route: { path: '/projects', meta: { title: '项目管理' } },
  router: { push: vi.fn(), replace: vi.fn() },
  auth: {
    user: { username: 'admin', role: 'ADMIN' },
    isAdmin: true,
    logout: vi.fn(),
  },
}));

vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
  RouterView: { template: '<div />' },
}));

function setRoute(path: string, title: string): void {
  mocks.route.path = path;
  mocks.route.meta = { title };
}

function setRole(role: 'ADMIN' | 'USER'): void {
  mocks.auth.user = { username: role === 'ADMIN' ? 'admin' : 'user', role };
  mocks.auth.isAdmin = role === 'ADMIN';
}

function mountLayout(): VueWrapper {
  return mount(AppLayout, {
    global: {
      plugins: [ElementPlus],
      stubs: { RouterView: { template: '<div />' } },
    },
  });
}

function menuLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-menu-item').map((item) => item.text().trim());
}

describe('AppLayout', () => {
  it('renders the complete administrator menu including task overview', () => {
    setRole('ADMIN');
    setRoute('/admin/agents', 'Agent 管理');
    const wrapper = mountLayout();

    expect(menuLabels(wrapper)).toEqual([
      '任务概览',
      '项目管理',
      'Agent 管理',
      '用户管理',
      '构建模板',
    ]);
    expect(wrapper.text()).toContain('系统管理');
    wrapper.unmount();
  });

  it('uses the project workspace scope on project routes', () => {
    setRole('ADMIN');
    setRoute('/projects', '项目管理');
    const wrapper = mountLayout();

    expect(wrapper.text()).toContain('项目工作区');
    expect(wrapper.text()).not.toContain('系统管理');
    wrapper.unmount();
  });

  it('keeps the administrator menu identical across project and admin routes', () => {
    setRole('ADMIN');
    setRoute('/projects', '项目管理');
    const projectWrapper = mountLayout();
    const projectMenu = menuLabels(projectWrapper);
    projectWrapper.unmount();

    setRoute('/admin/agents', 'Agent 管理');
    const adminWrapper = mountLayout();

    expect(menuLabels(adminWrapper)).toEqual(projectMenu);
    adminWrapper.unmount();
  });

  it('hides administrator entries for regular users', () => {
    setRole('USER');
    setRoute('/projects', '项目管理');
    const wrapper = mountLayout();

    expect(menuLabels(wrapper)).toEqual(['任务概览', '项目管理']);
    expect(wrapper.text()).not.toContain('Agent 管理');
    expect(wrapper.text()).not.toContain('用户管理');
    expect(wrapper.text()).not.toContain('构建模板');
    wrapper.unmount();
  });
});
