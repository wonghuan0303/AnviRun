import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import type { AgentPage, BuildTemplatePage } from '@/api/types';
import * as agentsApi from '@/api/agents';
import * as templatesApi from '@/api/build-templates';
import BuildTemplatesView from './BuildTemplatesView.vue';

vi.mock('@/api/agents', () => ({ listAgents: vi.fn() }));
vi.mock('@/api/build-templates', () => ({
  listBuildTemplates: vi.fn(),
  enableBuildTemplate: vi.fn(),
  disableBuildTemplate: vi.fn(),
  deleteBuildTemplate: vi.fn(),
}));

const agent = {
  id: 'agent-a',
  name: 'Agent A',
  enabled: true,
  status: 'OFFLINE' as const,
  hostname: null,
  os: null,
  arch: null,
  version: null,
  lastSeenAt: null,
  activeTaskId: null,
  createdAt: '',
  updatedAt: '',
};
const agents: AgentPage = { items: [agent], page: 1, pageSize: 100, total: 1 };
const templates: BuildTemplatePage = {
  items: [
    {
      id: 'template-a',
      name: '模板 A',
      description: null,
      agentId: 'agent-a',
      gitUrl: 'https://example.invalid/repo',
      command: 'pnpm build',
      artifactDir: 'dist',
      formSchema: [],
      interactiveInputEnabled: false,
      timeoutSeconds: 60,
      enabled: true,
      createdBy: 'admin',
      createdAt: '',
      updatedAt: '',
      agent,
    },
  ],
  page: 1,
  pageSize: 10,
  total: 1,
};

describe('BuildTemplatesView', () => {
  it('passes enabled and agent filters to the server list query', async () => {
    vi.mocked(agentsApi.listAgents).mockResolvedValue(agents);
    vi.mocked(templatesApi.listBuildTemplates).mockResolvedValue(templates);
    const wrapper = mount(BuildTemplatesView, {
      global: { plugins: [ElementPlus], stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    });
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      enabled: string;
      agentId: string;
      submitSearch: () => void;
    };
    vm.enabled = 'true';
    vm.agentId = 'agent-a';
    vm.submitSearch();
    await flushPromises();

    expect(templatesApi.listBuildTemplates).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, agentId: 'agent-a' }),
    );
    expect(wrapper.text()).toContain('交互输入');
    expect(wrapper.text()).toContain('已关闭');
  });
});
