import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

import type { ProjectView } from '@/api/types';
import * as projectApi from '@/api/project';
import * as templateApi from '@/api/build-templates';
import ProjectEditorView from './ProjectEditorView.vue';

const mocks = vi.hoisted(() => ({
  route: { params: { projectId: 'project-id' } },
  router: {
    back: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
}));

vi.mock('@/api/project', () => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock('@/api/build-templates', () => ({
  listPublicBuildTemplates: vi.fn(),
}));

const project: ProjectView = {
  id: 'project-id',
  ownerId: 'owner-id',
  name: 'demo-project',
  description: 'original description',
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

function mountView() {
  return mount(ProjectEditorView, {
    global: { plugins: [ElementPlus] },
  });
}

describe('ProjectEditorView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.route.params.projectId = 'project-id';
    vi.mocked(projectApi.getProject).mockResolvedValue({ project });
    vi.mocked(templateApi.listPublicBuildTemplates).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    vi.mocked(projectApi.updateProject).mockResolvedValue({ project });
  });

  it('uses the basic information title, guidance, and save label in edit mode', async () => {
    const wrapper = mountView();
    await vi.waitFor(() => expect(projectApi.getProject).toHaveBeenCalledWith('project-id'));

    expect(wrapper.text()).toContain('编辑基本信息');
    expect(wrapper.text()).not.toContain('编辑项目');
    expect(wrapper.text()).toContain('项目基本信息通常不需要频繁修改。');
    expect(wrapper.text()).toContain('Git 分支修改仅影响后续构建，历史任务不受影响。');
    expect(wrapper.text()).toContain('构建参数请前往“参数配置”页面修改。');
    expect(wrapper.text()).toContain('保存基本信息');
  });

  it('keeps basic information saving separate from parameter configuration', async () => {
    const wrapper = mountView();
    await vi.waitFor(() => expect(projectApi.getProject).toHaveBeenCalled());

    const inputs = wrapper.findAll('input');
    await inputs[0].setValue(' renamed-project ');
    await inputs[1].setValue(' release/2.0 ');
    await wrapper.find('textarea').setValue(' updated description ');
    await wrapper.find('form').trigger('submit');

    await vi.waitFor(() =>
      expect(projectApi.updateProject).toHaveBeenCalledWith('project-id', {
        name: 'renamed-project',
        description: 'updated description',
        branch: 'release/2.0',
      }),
    );
    expect(projectApi.createProject).not.toHaveBeenCalled();
    expect(mocks.router.replace).toHaveBeenCalledWith({
      name: 'project-detail',
      params: { projectId: 'project-id' },
    });
  });
});
