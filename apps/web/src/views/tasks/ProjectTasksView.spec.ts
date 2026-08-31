import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import type { ProjectView, TaskSummary } from '@/api/types';
import * as projectApi from '@/api/project';
import * as taskApi from '@/api/tasks';
import ProjectTasksView from './ProjectTasksView.vue';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  route: undefined as unknown as { params: { projectId: string } },
}));

vi.mock('@/api/project', () => ({ getProject: vi.fn() }));
vi.mock('@/api/tasks', () => ({ listProjectTasks: vi.fn(), createTask: vi.fn() }));
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  mocks.route = reactive({ params: { projectId: 'project-id' } });
  return {
    useRoute: () => mocks.route,
    useRouter: () => ({ push: mocks.push }),
  };
});

const project = {
  id: 'project-id',
  ownerId: 'owner-id',
  buildTemplateId: 'template-id',
  name: '演示项目',
  description: null,
  branch: 'main',
  config: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  owner: { id: 'owner-id', username: 'owner', role: 'USER', status: 'ACTIVE' },
  buildTemplate: {
    id: 'template-id',
    name: '模板',
    description: null,
    agentId: 'agent-id',
    enabled: true,
    agent: {
      id: 'agent-id',
      name: 'Agent',
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
} satisfies ProjectView;

const task = {
  id: '12345678-1234-4234-8234-123456789012',
  projectId: 'project-id',
  buildTemplateId: 'template-id',
  agentId: 'agent-id',
  createdBy: 'owner-id',
  status: 'RUNNING',
  statusReason: '正在执行',
  branch: 'main',
  config: {},
  sourceCommit: null,
  exitCode: null,
  queuedAt: null,
  startedAt: '2026-01-01T00:00:01.000Z',
  finishedAt: null,
  cancelRequestedAt: null,
  leaseExpiresAt: null,
  logSize: '0',
  artifactCount: '0',
  artifactBytes: '0',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  project,
  buildTemplate: project.buildTemplate,
  agent: project.buildTemplate.agent,
  creator: project.owner,
} satisfies TaskSummary;

describe('ProjectTasksView', () => {
  const mountedWrappers: Array<{ unmount: () => void }> = [];

  beforeEach(() => {
    mocks.route.params.projectId = 'project-id';
    vi.mocked(projectApi.getProject).mockReset();
    vi.mocked(taskApi.listProjectTasks).mockReset();
  });

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  });

  it('shows task status and keeps the build entry available for buildable projects', async () => {
    vi.mocked(projectApi.getProject).mockResolvedValue({ project });
    vi.mocked(taskApi.listProjectTasks).mockResolvedValue({
      items: [task],
      page: 1,
      pageSize: 10,
      total: 1,
    });

    const wrapper = mount(ProjectTasksView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();

    expect(wrapper.text()).toContain('演示项目');
    expect(wrapper.text()).toContain('执行中');
    expect(wrapper.text()).toContain('12345678');
    expect(wrapper.find('button.el-button--primary').attributes('disabled')).toBeUndefined();
  });

  it('reloads project and task list when the reused route changes projectId', async () => {
    const nextProject = { ...project, id: 'project-b', name: '新项目' };
    vi.mocked(projectApi.getProject)
      .mockResolvedValueOnce({ project })
      .mockResolvedValueOnce({ project: nextProject });
    vi.mocked(taskApi.listProjectTasks)
      .mockResolvedValueOnce({ items: [task], page: 1, pageSize: 10, total: 1 })
      .mockResolvedValueOnce({ items: [], page: 1, pageSize: 10, total: 0 });

    const wrapper = mount(ProjectTasksView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    mocks.route.params.projectId = 'project-b';
    await flushPromises();

    expect(vi.mocked(projectApi.getProject)).toHaveBeenLastCalledWith('project-b');
    expect(vi.mocked(taskApi.listProjectTasks)).toHaveBeenLastCalledWith('project-b', {
      page: 1,
      pageSize: 10,
      status: undefined,
    });
    expect(wrapper.text()).toContain('新项目');
  });
});
