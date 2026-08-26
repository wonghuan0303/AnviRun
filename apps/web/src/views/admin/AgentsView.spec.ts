import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import type { AgentPage } from '@/api/types';
import * as agentsApi from '@/api/agents';
import AgentsView from './AgentsView.vue';

vi.mock('@/api/agents', () => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  enableAgent: vi.fn(),
  disableAgent: vi.fn(),
  rotateAgentToken: vi.fn(),
  deleteAgent: vi.fn(),
}));

const page: AgentPage = {
  page: 1,
  pageSize: 10,
  total: 3,
  items: [
    {
      id: 'online',
      name: '在线节点',
      enabled: true,
      status: 'ONLINE',
      hostname: 'host-a',
      os: 'linux',
      arch: 'x64',
      version: '1',
      lastSeenAt: null,
      activeTaskId: null,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'offline',
      name: '离线节点',
      enabled: true,
      status: 'OFFLINE',
      hostname: null,
      os: null,
      arch: null,
      version: null,
      lastSeenAt: null,
      activeTaskId: null,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'disabled',
      name: '停用节点',
      enabled: false,
      status: 'DISABLED',
      hostname: null,
      os: null,
      arch: null,
      version: null,
      lastSeenAt: null,
      activeTaskId: null,
      createdAt: '',
      updatedAt: '',
    },
  ],
};

describe('AgentsView', () => {
  it('renders ONLINE, OFFLINE and DISABLED distinctly', async () => {
    vi.mocked(agentsApi.listAgents).mockResolvedValue(page);
    const wrapper = mount(AgentsView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    expect(wrapper.text()).toContain('在线');
    expect(wrapper.text()).toContain('离线');
    expect(wrapper.text()).toContain('已停用');
    expect(wrapper.text()).toContain('在线节点');
    expect(wrapper.text()).toContain('离线节点');
  });
});
