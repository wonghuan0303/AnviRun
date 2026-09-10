import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import type { ProjectView } from '@/api/types';
import * as projectApi from '@/api/project';
import FormConfigEditor from '@/form-schema/FormConfigEditor.vue';
import ProjectConfigView from './ProjectConfigView.vue';

const mocks = vi.hoisted(() => ({
  route: { params: { projectId: 'project-id' } },
  router: {
    back: vi.fn(),
    push: vi.fn(),
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
}));

vi.mock('@/api/project', () => ({
  getProject: vi.fn(),
  saveProjectConfig: vi.fn(),
}));

const project: ProjectView = {
  id: 'project-id',
  ownerId: 'owner-id',
  name: 'demo-project',
  description: null,
  branch: 'main',
  buildTemplateId: 'template-id',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  owner: { id: 'owner-id', username: 'owner', role: 'USER', status: 'ACTIVE' },
  buildTemplate: {
    id: 'template-id',
    name: 'demo-template',
    description: null,
    agentId: 'agent-id',
    enabled: true,
    agent: {
      id: 'agent-id',
      name: 'demo-agent',
      enabled: true,
      status: 'ONLINE',
      hostname: null,
      os: null,
      arch: null,
      version: null,
      lastSeenAt: null,
    },
    formSchema: [],
  },
  config: {},
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

describe('ProjectConfigView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectApi.getProject).mockResolvedValue({ project });
    vi.mocked(projectApi.saveProjectConfig).mockResolvedValue({ project });
  });

  it('uses parameter configuration copy while keeping the schema-driven editor', async () => {
    const wrapper = mount(ProjectConfigView, {
      global: { plugins: [ElementPlus] },
    });
    await vi.waitFor(() => expect(projectApi.getProject).toHaveBeenCalledWith('project-id'));
    await flushPromises();

    expect(wrapper.text()).toContain('参数配置');
    expect(wrapper.text()).toContain('保存参数配置');
    expect(wrapper.text()).not.toContain('项目配置');
    expect(wrapper.findComponent(FormConfigEditor).exists()).toBe(true);
  });

  it('saves the normalized parameter configuration through the existing API', async () => {
    const wrapper = mount(ProjectConfigView, {
      global: { plugins: [ElementPlus] },
    });
    await vi.waitFor(() => expect(projectApi.getProject).toHaveBeenCalled());
    await flushPromises();

    const saveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存参数配置'));
    expect(saveButton).toBeDefined();
    await saveButton!.trigger('click');

    await vi.waitFor(() =>
      expect(projectApi.saveProjectConfig).toHaveBeenCalledWith('project-id', {}),
    );
  });
});
