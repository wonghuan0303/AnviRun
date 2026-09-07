import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';
import { ElMessageBox } from 'element-plus';

import { ApiError } from '@/api/client';
import type { AdminUserPage } from '@/api/types';
import * as usersApi from '@/api/users';
import UsersView from './UsersView.vue';

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: 'admin-id', username: 'admin', role: 'ADMIN', status: 'ACTIVE' },
    clearSession: vi.fn(),
  },
  router: { replace: vi.fn() },
}));

vi.mock('@/api/users', () => ({
  listAdminUsers: vi.fn(),
  createAdminUser: vi.fn(),
  enableAdminUser: vi.fn(),
  disableAdminUser: vi.fn(),
  resetAdminUserPassword: vi.fn(),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('vue-router', () => ({ useRouter: () => mocks.router }));

const page: AdminUserPage = {
  page: 1,
  pageSize: 10,
  total: 2,
  metrics: { total: 4, active: 3, disabled: 1, admins: 2 },
  items: [
    {
      id: 'admin-id',
      username: 'admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'disabled-id',
      username: 'disabled-user',
      role: 'USER',
      status: 'DISABLED',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    },
  ],
};

const pageWithActiveUser: AdminUserPage = {
  ...page,
  total: 3,
  items: [
    page.items[0],
    {
      id: 'active-user-id',
      username: 'active-user',
      role: 'USER',
      status: 'ACTIVE',
      createdAt: '2026-01-05T00:00:00.000Z',
      updatedAt: '2026-01-06T00:00:00.000Z',
    },
    page.items[1],
  ],
};

function mountView() {
  return mount(UsersView, { global: { plugins: [ElementPlus] } });
}

describe('UsersView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders metrics, filters and safe user fields', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(page);
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('用户总数');
    expect(wrapper.text()).toContain('启用用户');
    expect(wrapper.text()).toContain('禁用用户');
    expect(wrapper.text()).toContain('管理员');
    expect(wrapper.text()).toContain('当前用户');
    expect(wrapper.text()).toContain('disabled-user');
    expect(wrapper.text()).not.toContain('passwordHash');
    expect(wrapper.text()).not.toContain('tokenVersion');
    expect(usersApi.listAdminUsers).toHaveBeenCalledWith({
      page: 1,
      pageSize: 10,
      search: '',
      role: undefined,
      status: undefined,
    });
  });

  it('submits filters and loads the selected page and page size', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(page);
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('.filter-card input').setValue('active');
    const filters = wrapper.findAllComponents({ name: 'ElSelect' });
    await filters[0].vm.$emit('update:modelValue', 'ADMIN');
    await filters[1].vm.$emit('update:modelValue', 'ACTIVE');
    const pagination = wrapper.findComponent({ name: 'ElPagination' });
    const state = wrapper.vm as unknown as { page: number; pageSize: number };
    state.page = 3;
    await wrapper
      .findAll('.filter-card button')
      .find((button) => button.text() === '搜索')!
      .trigger('click');
    await flushPromises();

    expect(usersApi.listAdminUsers).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 10,
      search: 'active',
      role: 'ADMIN',
      status: 'ACTIVE',
    });

    state.page = 2;
    await pagination.vm.$emit('current-change', 2);
    await flushPromises();
    expect(usersApi.listAdminUsers).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 10,
      search: 'active',
      role: 'ADMIN',
      status: 'ACTIVE',
    });

    state.pageSize = 20;
    await pagination.vm.$emit('size-change', 20);
    await flushPromises();
    expect(usersApi.listAdminUsers).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 20,
      search: 'active',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
  });

  it('resets all filters, returns to the first page and reloads', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(page);
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('.filter-card input').setValue('stale-search');
    const filters = wrapper.findAllComponents({ name: 'ElSelect' });
    await filters[0].vm.$emit('update:modelValue', 'ADMIN');
    await filters[1].vm.$emit('update:modelValue', 'DISABLED');
    const pagination = wrapper.findComponent({ name: 'ElPagination' });
    const state = wrapper.vm as unknown as { page: number };
    state.page = 4;

    await wrapper
      .findAll('.filter-card button')
      .find((button) => button.text() === '重置')!
      .trigger('click');
    await flushPromises();

    expect((wrapper.find('.filter-card input').element as HTMLInputElement).value).toBe('');
    expect(filters[0].props('modelValue')).toBe('');
    expect(filters[1].props('modelValue')).toBe('');
    expect(pagination.props('currentPage')).toBe(1);
    expect(usersApi.listAdminUsers).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 10,
      search: '',
      role: undefined,
      status: undefined,
    });
  });

  it('shows enable for disabled users and refreshes after enabling', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(page);
    vi.mocked(usersApi.enableAdminUser).mockResolvedValue({
      id: 'disabled-id',
      username: 'disabled-user',
      role: 'USER',
      status: 'ACTIVE',
    });
    const wrapper = mountView();
    await flushPromises();

    const enableButton = wrapper.findAll('button').find((button) => button.text() === '启用');
    expect(enableButton).toBeDefined();
    await enableButton!.trigger('click');
    await flushPromises();

    expect(usersApi.enableAdminUser).toHaveBeenCalledWith('disabled-id');
    expect(usersApi.listAdminUsers).toHaveBeenCalledTimes(2);
  });

  it('does not submit a mismatched create password', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(page);
    const wrapper = mountView();
    await flushPromises();

    const openButton = wrapper.findAll('button').find((button) => button.text() === '创建用户');
    expect(openButton).toBeDefined();
    await openButton!.trigger('click');
    await flushPromises();

    const inputs = wrapper.findAll('.el-dialog input');
    await inputs[0].setValue('new-user');
    await inputs[1].setValue('valid password');
    await inputs[2].setValue('different password');
    const submit = wrapper
      .findAll('.el-dialog .el-button')
      .find((button) => button.text() === '创建');
    expect(submit).toBeDefined();
    await submit!.trigger('click');

    expect(usersApi.createAdminUser).not.toHaveBeenCalled();
  });

  it('creates a user, clears the form and reloads the list after success', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(page);
    vi.mocked(usersApi.createAdminUser).mockResolvedValue({
      id: 'new-user-id',
      username: 'new-user',
      role: 'USER',
      status: 'ACTIVE',
    });
    const wrapper = mountView();
    await flushPromises();

    await wrapper
      .findAll('button')
      .find((button) => button.text() === '创建用户')!
      .trigger('click');
    await flushPromises();
    const inputs = wrapper.findAll('.el-dialog input');
    await inputs[0].setValue('new-user');
    await inputs[1].setValue('valid password');
    await inputs[2].setValue('valid password');
    await wrapper
      .findAll('.el-dialog .el-button')
      .find((button) => button.text() === '创建')!
      .trigger('click');
    await flushPromises();

    expect(usersApi.createAdminUser).toHaveBeenCalledWith({
      username: 'new-user',
      password: 'valid password',
      role: 'USER',
    });
    expect(usersApi.listAdminUsers).toHaveBeenCalledTimes(2);
    const clearedInputs = wrapper.findAll('.el-dialog input');
    expect((clearedInputs[1].element as HTMLInputElement).value).toBe('');
    expect((clearedInputs[2].element as HTMLInputElement).value).toBe('');
    expect(wrapper.findAllComponents({ name: 'ElDialog' })[0].props('modelValue')).toBe(false);
  });

  it('clears the session after resetting the current user password', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(page);
    vi.mocked(usersApi.resetAdminUserPassword).mockResolvedValue({
      id: 'admin-id',
      username: 'admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    const wrapper = mountView();
    await flushPromises();

    const resetButton = wrapper.findAll('button').find((button) => button.text() === '重置密码');
    expect(resetButton).toBeDefined();
    await resetButton!.trigger('click');
    await flushPromises();

    const inputs = wrapper.findAll('.el-dialog input');
    await inputs[0].setValue('new valid password');
    await inputs[1].setValue('new valid password');
    const submit = wrapper
      .findAll('.el-dialog .el-button')
      .find((button) => button.text() === '重置');
    expect(submit).toBeDefined();
    await submit!.trigger('click');
    await flushPromises();

    expect(usersApi.resetAdminUserPassword).toHaveBeenCalledWith('admin-id', 'new valid password');
    expect(mocks.auth.clearSession).toHaveBeenCalled();
    expect(mocks.router.replace).toHaveBeenCalledWith({ name: 'login' });
  });

  it('renders the empty state when there are no users', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue({ ...page, items: [], total: 0 });
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('暂无用户');
  });

  it('disables only another active user after confirmation', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(pageWithActiveUser);
    vi.mocked(usersApi.disableAdminUser).mockResolvedValue({
      id: 'active-user-id',
      username: 'active-user',
      role: 'USER',
      status: 'DISABLED',
    });
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);
    const wrapper = mountView();
    await flushPromises();

    const disableButtons = wrapper.findAll('button').filter((button) => button.text() === '禁用');
    expect(disableButtons).toHaveLength(2);
    expect((disableButtons[0].element as HTMLButtonElement).disabled).toBe(true);
    expect((disableButtons[1].element as HTMLButtonElement).disabled).toBe(false);

    await disableButtons[1].trigger('click');
    await flushPromises();

    expect(confirm).toHaveBeenCalled();
    expect(usersApi.disableAdminUser).toHaveBeenCalledWith('active-user-id');
    expect(usersApi.listAdminUsers).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('does not disable a user when the confirmation is cancelled', async () => {
    vi.mocked(usersApi.listAdminUsers).mockResolvedValue(pageWithActiveUser);
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel');
    const wrapper = mountView();
    await flushPromises();

    const normalDisable = wrapper.findAll('button').filter((button) => button.text() === '禁用')[1];
    await normalDisable.trigger('click');
    await flushPromises();

    expect(confirm).toHaveBeenCalled();
    expect(usersApi.disableAdminUser).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('shows only a safe error message when an API request fails', async () => {
    vi.mocked(usersApi.listAdminUsers).mockRejectedValue(
      new ApiError(
        {
          code: 'VALIDATION_FAILED',
          message: 'passwordHash tokenVersion Token internal implementation',
        },
        400,
      ),
    );
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('请求参数校验失败');
    expect(wrapper.text()).not.toMatch(/passwordHash|tokenVersion|Token|internal implementation/i);
  });
});
