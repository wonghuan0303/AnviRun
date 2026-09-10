import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ElementPlus, { ElMessageBox } from 'element-plus';

import type { ProjectView } from '@/api/types';
import * as projectApi from '@/api/project';
import * as taskApi from '@/api/tasks';
import ProjectDetailView from './ProjectDetailView.vue';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  deleteProject: vi.fn(),
  createTask: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  route: undefined as unknown as { params: { projectId: string } },
}));

vi.mock('@/api/project', () => ({
  getProject: mocks.getProject,
  deleteProject: mocks.deleteProject,
}));
vi.mock('@/api/tasks', () => ({ createTask: mocks.createTask }));
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  mocks.route = reactive({ params: { projectId: 'project-id' } });
  return {
    useRoute: () => mocks.route,
    useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  };
});

const project: ProjectView = {
  id: 'project-id',
  ownerId: 'owner-id',
  buildTemplateId: 'template-id',
  name: '演示项目',
  description: '项目说明',
  branch: 'main',
  config: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  owner: { id: 'owner-id', username: 'owner', role: 'USER', status: 'ACTIVE' },
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

function mountView() {
  return mount(ProjectDetailView, { global: { plugins: [ElementPlus] } });
}

describe('ProjectDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.route.params.projectId = 'project-id';
  });

  it('keeps primary project actions and groups edit/delete under more', async () => {
    vi.mocked(projectApi.getProject).mockResolvedValue({ project });
    const wrapper = mountView();
    await flushPromises();

    const actionLabels = wrapper
      .findAll('.page-heading__actions button')
      .map((button) => button.text().trim());
    expect(actionLabels).toEqual(['返回列表', '开始构建', '参数配置', '构建记录', '更多']);
    expect(actionLabels).not.toContain('编辑配置');
    expect(actionLabels).not.toContain('删除');

    await wrapper
      .findAll('.page-heading__actions button')
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
    expect(mocks.replace).toHaveBeenCalledWith({ name: 'projects' });
    confirm.mockRestore();
  });

  it('highlights parameter repair and keeps build disabled for invalid configuration', async () => {
    const invalidProject = {
      ...project,
      configCompatibility: {
        ...project.configCompatibility,
        valid: false,
        buildable: false,
        missingFields: ['required-field'],
      },
    } satisfies ProjectView;
    vi.mocked(projectApi.getProject).mockResolvedValue({ project: invalidProject });
    const wrapper = mountView();
    await flushPromises();

    const actions = wrapper.findAll('.page-heading__actions button');
    const buildButton = actions.find((button) => button.text() === '开始构建');
    const repairButton = actions.find((button) => button.text() === '修正参数配置');
    expect(buildButton).toBeDefined();
    expect((buildButton!.element as HTMLButtonElement).disabled).toBe(true);
    expect(buildButton!.attributes('title')).toContain('修正配置');
    expect(repairButton).toBeDefined();
    await repairButton!.trigger('click');
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'project-config',
      params: { projectId: 'project-id' },
    });
    expect(wrapper.text()).toContain('参数配置兼容性诊断');
    expect(wrapper.text()).toContain('修正参数配置');
  });

  it('keeps the build flow available for buildable projects', async () => {
    vi.mocked(projectApi.getProject).mockResolvedValue({ project });
    vi.mocked(taskApi.createTask).mockResolvedValue({
      task: { id: 'task-id' },
    } as never);
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);
    const wrapper = mountView();
    await flushPromises();

    await wrapper
      .findAll('.page-heading__actions button')
      .find((button) => button.text() === '开始构建')!
      .trigger('click');
    await flushPromises();

    expect(taskApi.createTask).toHaveBeenCalledWith('project-id');
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'task-detail',
      params: { taskId: 'task-id' },
    });
    confirm.mockRestore();
  });
});
