import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import type { ProjectView } from '@/api/types';
import ProjectsView from './ProjectsView.vue';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listPublicBuildTemplates: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/api/project', () => ({ listProjects: mocks.listProjects, deleteProject: vi.fn() }));
vi.mock('@/api/build-templates', () => ({
  listPublicBuildTemplates: mocks.listPublicBuildTemplates,
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
});
