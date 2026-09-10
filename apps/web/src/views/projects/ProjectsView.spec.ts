import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ElementPlus, { ElMessageBox } from 'element-plus';

import type { ProjectView } from '@/api/types';
import { taskStatusLabel } from '@/views/tasks/task-status';
import ProjectsView from './ProjectsView.vue';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listPublicBuildTemplates: vi.fn(),
  listProjectTasks: vi.fn(),
  createTask: vi.fn(),
  cancelTask: vi.fn(),
  deleteProject: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/api/project', () => ({
  listProjects: mocks.listProjects,
  deleteProject: mocks.deleteProject,
}));
vi.mock('@/api/build-templates', () => ({
  listPublicBuildTemplates: mocks.listPublicBuildTemplates,
}));
vi.mock('@/api/tasks', () => ({
  listProjectTasks: mocks.listProjectTasks,
  createTask: mocks.createTask,
  cancelTask: mocks.cancelTask,
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isAdmin: false }),
}));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

const project: ProjectView = {
  id: 'project-id',
  ownerId: 'owner-id',
  buildTemplateId: 'template-id',
  name: '我的项目',
  description: null,
  branch: 'main',
  config: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  owner: { id: 'owner-id', username: 'user', role: 'USER', status: 'ACTIVE' },
  buildTemplate: {
    id: 'template-id',
    name: 'Node 模板',
    description: null,
    agentId: 'agent-id',
    enabled: true,
    agent: {
      id: 'agent-id',
      name: 'Agent A',
      enabled: true,
      status: 'ONLINE',
      hostname: null,
      os: null,
      arch: null,
      version: null,
      lastSeenAt: null,
    },
  },
  configCompatibility: {
    valid: true,
    effectiveConfig: {},
    missingFields: [],
    obsoleteFields: [],
    typeConflictFields: [],
    issues: [],
    templateEnabled: true,
    agentEnabled: true,
    buildable: true,
  },
};

describe('ProjectsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('loads and renders the authenticated user project list', async () => {
    mocks.listProjects.mockResolvedValue({
      items: [project],
      page: 1,
      pageSize: 10,
      total: 1,
    });
    mocks.listPublicBuildTemplates.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
    });

    const wrapper = mount(ProjectsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    expect(wrapper.text()).toContain('我的项目');
    expect(wrapper.text()).toContain('Node 模板');
    expect(wrapper.text()).toContain('在线');
    expect(wrapper.text()).not.toContain('用户名');
    expect(mocks.listProjects).toHaveBeenCalledWith({
      page: 1,
      pageSize: 10,
      search: '',
      buildTemplateId: undefined,
    });
  });

  it('promotes parameter configuration and groups edit/delete under more', async () => {
    mocks.listProjects.mockResolvedValue({ items: [project], page: 1, pageSize: 10, total: 1 });
    mocks.listPublicBuildTemplates.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
    });

    const wrapper = mount(ProjectsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    const actionButtons = wrapper
      .findAll('.table-card button')
      .map((button) => button.text().trim());
    expect(actionButtons.filter(Boolean).slice(-3)).toEqual(['详情', '参数配置', '更多']);
    expect(actionButtons).not.toContain('编辑');
    expect(actionButtons).not.toContain('删除');

    await wrapper
      .findAll('.table-card button')
      .find((button) => button.text() === '参数配置')!
      .trigger('click');
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'project-config',
      params: { projectId: 'project-id' },
    });

    const dropdown = wrapper.findComponent({ name: 'ElDropdown' });
    await dropdown.vm.$emit('command', 'edit');
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'project-edit',
      params: { projectId: 'project-id' },
    });

    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);
    mocks.deleteProject.mockResolvedValue(undefined);
    await dropdown.vm.$emit('command', 'delete');
    await flushPromises();
    expect(confirm).toHaveBeenCalled();
    expect(mocks.deleteProject).toHaveBeenCalledWith('project-id');
    confirm.mockRestore();
  });

  it('shows play and stop icon buttons directly beside the more menu', async () => {
    mocks.listProjects.mockResolvedValue({ items: [project], page: 1, pageSize: 10, total: 1 });
    mocks.listPublicBuildTemplates.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
    });
    mocks.listProjectTasks.mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 });

    const wrapper = mount(ProjectsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    const startButton = wrapper.find('button[aria-label="开始构建"]');
    const stopButton = wrapper.find('button[aria-label="停止构建"]');
    expect(startButton.exists()).toBe(true);
    expect(stopButton.exists()).toBe(true);
    expect(startButton.attributes('disabled')).toBeUndefined();
    expect(stopButton.attributes('disabled')).toBeDefined();
    expect((startButton.element as HTMLButtonElement).tabIndex).not.toBe(-1);
    expect(wrapper.find('.project-operation-actions').exists()).toBe(true);
    expect(wrapper.find('.project-operation-shortcuts').exists()).toBe(true);

    const tooltips = wrapper
      .findAllComponents({ name: 'ElTooltip' })
      .map((tooltip) => tooltip.props('content'));
    expect(tooltips).toContain('开始构建');
    expect(tooltips).toContain('当前没有可停止的构建');

    await wrapper
      .findAll('.table-card button')
      .find((button) => button.text().trim() === '更多')!
      .trigger('click');
    await flushPromises();

    const menuItems = Array.from(document.body.querySelectorAll('.el-dropdown-menu__item')).map(
      (item) => item.textContent?.trim(),
    );
    expect(menuItems).toEqual(['编辑基本信息', '删除项目']);
    expect(menuItems).not.toContain('开始构建');
    expect(menuItems).not.toContain('停止构建');
    wrapper.unmount();
  });

  it('shows the disabled build reason in the start tooltip', async () => {
    const invalidProject = {
      ...project,
      configCompatibility: {
        ...project.configCompatibility,
        valid: false,
        buildable: false,
      },
    };
    mocks.listProjects.mockResolvedValue({
      items: [invalidProject],
      page: 1,
      pageSize: 10,
      total: 1,
    });
    mocks.listPublicBuildTemplates.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
    });
    mocks.listProjectTasks.mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 });

    const wrapper = mount(ProjectsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    const startButton = wrapper.find('button[aria-label="开始构建"]');
    expect(startButton.attributes('disabled')).toBeDefined();
    expect(
      wrapper.findAllComponents({ name: 'ElTooltip' }).map((tooltip) => tooltip.props('content')),
    ).toContain('配置无效，请先修正参数配置');
    wrapper.unmount();
  });

  it('starts and stops builds through the dedicated icon buttons', async () => {
    mocks.listProjects.mockResolvedValue({ items: [project], page: 1, pageSize: 10, total: 1 });
    mocks.listPublicBuildTemplates.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
    });
    mocks.listProjectTasks.mockResolvedValue({
      items: [{ id: 'task-id', status: 'RUNNING' }],
      page: 1,
      pageSize: 100,
      total: 1,
    });
    mocks.createTask.mockResolvedValue({ task: { id: 'created-task-id' } });
    mocks.cancelTask.mockResolvedValue({ task: { id: 'task-id', status: 'CANCELING' } });
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);

    const wrapper = mount(ProjectsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    const startButton = wrapper.find('button[aria-label="开始构建"]');
    const stopButton = wrapper.find('button[aria-label="停止构建"]');
    await vi.waitFor(() => expect(stopButton.attributes('disabled')).toBeUndefined());

    await startButton.trigger('click');
    await flushPromises();
    expect(mocks.createTask).toHaveBeenCalledWith('project-id');
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'task-detail',
      params: { taskId: 'created-task-id' },
    });

    await stopButton.trigger('click');
    await flushPromises();
    expect(mocks.cancelTask).toHaveBeenCalledWith('task-id');
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
    wrapper.unmount();
  });

  it('requires an explicit task selection when multiple active tasks can be stopped', async () => {
    mocks.listProjects.mockResolvedValue({ items: [project], page: 1, pageSize: 10, total: 1 });
    mocks.listPublicBuildTemplates.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
    });
    mocks.listProjectTasks.mockResolvedValue({
      items: [
        {
          id: 'task-first',
          status: 'RUNNING',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'task-second',
          status: 'QUEUED',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 100,
      total: 2,
    });
    mocks.cancelTask.mockResolvedValue({ task: { id: 'task-second', status: 'CANCELING' } });

    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);
    const wrapper = mount(ProjectsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    const stopButton = wrapper.find('button[aria-label="停止构建"]');
    await vi.waitFor(() => expect(stopButton.attributes('disabled')).toBeUndefined());
    await stopButton.trigger('click');
    await flushPromises();
    await vi.waitFor(() =>
      expect(wrapper.findComponent({ name: 'ElDialog' }).props('modelValue')).toBe(true),
    );

    const stopDialog = wrapper.findComponent({ name: 'ElDialog' });
    const taskOptions = stopDialog.findAll('.project-stop-task-option');
    expect(stopDialog.props('width')).toBe('min(460px, calc(100vw - 32px))');
    expect(confirm).not.toHaveBeenCalled();
    expect(mocks.cancelTask).not.toHaveBeenCalled();
    expect(taskOptions).toHaveLength(2);
    expect(taskOptions[0]?.text()).toContain('task-first');
    expect(taskOptions[1]?.text()).toContain('task-second');

    const stopDialogConfirm = stopDialog
      .findAll('button')
      .find((button) => button.text().trim() === '停止构建');
    expect(stopDialogConfirm).toBeDefined();
    expect((stopDialogConfirm?.element as HTMLButtonElement).disabled).toBe(true);

    const secondTaskOption = taskOptions.find((option) => option.text().includes('task-second'));
    expect(secondTaskOption).toBeDefined();
    if (!secondTaskOption) throw new Error('second task option not found');
    await secondTaskOption.find('input').setValue(true);
    await flushPromises();

    expect((stopDialogConfirm?.element as HTMLButtonElement).disabled).toBe(false);
    await stopDialogConfirm?.trigger('click');
    await flushPromises();

    expect(mocks.cancelTask).toHaveBeenCalledWith('task-second');
    expect(mocks.cancelTask).not.toHaveBeenCalledWith('task-first');
    const confirmationMessage = String(confirm.mock.calls[0]?.[0]);
    expect(confirmationMessage).toContain('task-second');
    expect(confirmationMessage).toContain(taskStatusLabel('QUEUED'));

    confirm.mockRestore();
    wrapper.unmount();
  });
  it('keeps the icon buttons in loading state while requests are pending', async () => {
    mocks.listProjects.mockResolvedValue({ items: [project], page: 1, pageSize: 10, total: 1 });
    mocks.listPublicBuildTemplates.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
    });
    mocks.listProjectTasks.mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 });

    let resolveCreate: (value: unknown) => void = () => undefined;
    mocks.createTask.mockReturnValue(
      new Promise<unknown>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);

    const startWrapper = mount(ProjectsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    const startButton = startWrapper.find('button[aria-label="开始构建"]');
    await startButton.trigger('click');
    await flushPromises();
    expect(startButton.classes()).toContain('is-loading');
    resolveCreate({ task: { id: 'created-task-id' } });
    await flushPromises();
    startWrapper.unmount();

    mocks.listProjectTasks.mockResolvedValue({
      items: [{ id: 'task-id', status: 'RUNNING' }],
      page: 1,
      pageSize: 100,
      total: 1,
    });
    let resolveCancel: (value: unknown) => void = () => undefined;
    mocks.cancelTask.mockReturnValue(
      new Promise<unknown>((resolve) => {
        resolveCancel = resolve;
      }),
    );

    const stopWrapper = mount(ProjectsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    const stopButton = stopWrapper.find('button[aria-label="停止构建"]');
    await vi.waitFor(() => expect(stopButton.attributes('disabled')).toBeUndefined());
    await stopButton.trigger('click');
    await flushPromises();
    expect(stopButton.classes()).toContain('is-loading');
    resolveCancel({ task: { id: 'task-id', status: 'CANCELING' } });
    await flushPromises();
    confirm.mockRestore();
    stopWrapper.unmount();
  });
});
