import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import type { OverviewResponse } from '@/api/types';
import OverviewView from './OverviewView.vue';

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/api/overview', () => ({ getOverview: mocks.getOverview }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));

const overview: OverviewResponse = {
  generatedAt: '2026-09-03T10:00:00.000Z',
  metrics: { agentTotal: 1, onlineAgentCount: 1, runningTaskCount: 1, queuedTaskCount: 1 },
  agents: [
    {
      id: 'agent-id',
      name: '构建 Agent',
      enabled: true,
      status: 'ONLINE',
      hostname: 'build-host',
      lastSeenAt: '2026-09-03T09:59:00.000Z',
      runningTasks: [
        {
          id: 'running-task',
          projectId: 'project-id',
          agentId: 'agent-id',
          status: 'RUNNING',
          projectName: '演示项目',
          templateName: 'Node 模板',
          createdAt: '2026-09-03T09:50:00.000Z',
          queuedAt: '2026-09-03T09:50:00.000Z',
          startedAt: '2026-09-03T09:55:00.000Z',
          finishedAt: null,
          updatedAt: '2026-09-03T09:59:00.000Z',
        },
      ],
      queuedTasks: [
        {
          id: 'queued-task',
          projectId: 'project-id',
          agentId: 'agent-id',
          status: 'WAITING_AGENT',
          projectName: '等待项目',
          templateName: 'Node 模板',
          createdAt: '2026-09-03T09:58:00.000Z',
          queuedAt: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: '2026-09-03T09:58:00.000Z',
        },
      ],
      recentTasks: [
        {
          id: 'recent-task-succeeded',
          projectId: 'project-id',
          agentId: 'agent-id',
          status: 'SUCCEEDED',
          projectName: '最近完成项目',
          templateName: 'Node 模板',
          createdAt: '2026-09-03T09:40:00.000Z',
          queuedAt: '2026-09-03T09:40:00.000Z',
          startedAt: '2026-09-03T09:41:00.000Z',
          finishedAt: '2026-09-03T09:45:00.000Z',
          updatedAt: '2026-09-03T09:45:00.000Z',
        },
      ],
    },
  ],
};

describe('OverviewView', () => {
  beforeEach(() => {
    mocks.getOverview.mockReset();
    mocks.push.mockReset();
    mocks.getOverview.mockResolvedValue(overview);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  it('renders metrics and groups running and queued tasks by Agent', async () => {
    const wrapper = mount(OverviewView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    expect(wrapper.text()).toContain('任务概览');
    expect(wrapper.text()).toContain('Agent 总数');
    expect(wrapper.text()).toContain('构建 Agent');
    expect(wrapper.text()).toContain('演示项目');
    expect(wrapper.text()).toContain('等待 Agent 上线');
    expect(wrapper.text()).toContain('最近完成');
    expect(wrapper.text()).toContain('最近完成项目');
    expect(wrapper.text()).toContain('成功');
    expect(wrapper.text()).toContain(new Date('2026-09-03T09:45:00.000Z').toLocaleString());
    expect(wrapper.findAll('.overview-task')).toHaveLength(3);
    wrapper.unmount();
  });

  it('opens the existing task detail route from a task card', async () => {
    const wrapper = mount(OverviewView, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.find('.overview-task').trigger('click');

    expect(mocks.push).toHaveBeenCalledWith({
      name: 'task-detail',
      params: { taskId: 'running-task' },
    });
    wrapper.unmount();
  });

  it('opens the task detail route from a recent task card', async () => {
    const wrapper = mount(OverviewView, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.find('.overview-task--recent').trigger('click');

    expect(mocks.push).toHaveBeenCalledWith({
      name: 'task-detail',
      params: { taskId: 'recent-task-succeeded' },
    });
    wrapper.unmount();
  });

  it('shows an empty state when an Agent has no recent tasks', async () => {
    mocks.getOverview.mockResolvedValue({
      ...overview,
      agents: [{ ...overview.agents[0], recentTasks: [] }],
    });
    const wrapper = mount(OverviewView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    expect(wrapper.text()).toContain('最近完成');
    expect(wrapper.text()).toContain('暂无历史任务');
    expect(wrapper.find('.overview-task--recent').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows a safe error without exposing implementation details', async () => {
    mocks.getOverview.mockRejectedValue(new Error('Prisma connection details'));
    const wrapper = mount(OverviewView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    expect(wrapper.text()).toContain('任务概览加载失败');
    expect(wrapper.text()).not.toContain('Prisma connection details');
    wrapper.unmount();
  });
});
