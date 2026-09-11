import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';

import * as artifactApi from '@/api/artifacts';
import * as taskApi from '@/api/tasks';
import type { ArtifactPage, TaskDetail } from '@/api/types';
import TaskDetailView from './TaskDetailView.vue';

class TestWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly url: string;
  readyState = TestWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    TestWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  closeWithCode(code: number): void {
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  close(): void {
    this.closeCalls += 1;
    this.closeWithCode(1000);
  }
}

const mocks = vi.hoisted(() => ({
  route: undefined as unknown as {
    params: { taskId: string };
    fullPath: string;
  },
  push: vi.fn(),
  replace: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock('@/api/tasks', () => ({
  getTask: vi.fn(),
  readTaskLogs: vi.fn(),
  cancelTask: vi.fn(),
  rebuildTask: vi.fn(),
}));
vi.mock('@/api/artifacts', () => ({
  listTaskArtifacts: vi.fn(),
  downloadTaskArchive: vi.fn(),
  downloadArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'access-token', refreshSession: mocks.refreshSession }),
}));
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  mocks.route = reactive({ params: { taskId: 'task-id' }, fullPath: '/tasks/task-id' });
  return {
    useRoute: () => mocks.route,
    useRouter: () => ({ push: mocks.push, replace: mocks.replace, back: vi.fn() }),
  };
});

const task = {
  id: 'task-id',
  projectId: 'project-id',
  buildTemplateId: 'template-id',
  agentId: 'agent-id',
  createdBy: 'owner-id',
  status: 'FAILED',
  statusReason: '命令退出码为 1',
  branch: 'main',
  config: {},
  interactiveInputEnabled: false,
  sourceCommit: null,
  exitCode: 1,
  queuedAt: null,
  startedAt: null,
  finishedAt: '2026-01-01T00:00:01.000Z',
  cancelRequestedAt: null,
  leaseExpiresAt: null,
  logSize: '0',
  artifactCount: '0',
  artifactBytes: '0',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  project: {
    id: 'project-id',
    ownerId: 'owner-id',
    name: '项目',
    description: null,
    branch: 'main',
    owner: { id: 'owner-id', username: 'owner', role: 'USER', status: 'ACTIVE' },
  },
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
      status: 'OFFLINE',
      hostname: null,
      os: null,
      arch: null,
      version: null,
      lastSeenAt: null,
    },
  },
  agent: {
    id: 'agent-id',
    name: 'Agent',
    enabled: true,
    status: 'OFFLINE',
    hostname: null,
    os: null,
    arch: null,
    version: null,
    lastSeenAt: null,
  },
  creator: { id: 'owner-id', username: 'owner', role: 'USER', status: 'ACTIVE' },
  statusHistory: [
    {
      id: 'history-1',
      fromStatus: null,
      toStatus: 'CREATED',
      source: 'SERVER',
      reason: null,
      occurredAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'history-2',
      fromStatus: 'CREATED',
      toStatus: 'FAILED',
      source: 'AGENT',
      reason: '命令失败',
      occurredAt: '2026-01-01T00:00:01.000Z',
    },
  ],
} satisfies TaskDetail;

describe('TaskDetailView', () => {
  const mountedWrappers: Array<{ unmount: () => void }> = [];

  beforeEach(() => {
    mocks.route.params.taskId = 'task-id';
    mocks.route.fullPath = '/tasks/task-id';
    mocks.refreshSession.mockReset();
    vi.mocked(taskApi.getTask).mockReset();
    vi.mocked(taskApi.readTaskLogs).mockReset();
    vi.mocked(artifactApi.listTaskArtifacts).mockReset();
    TestWebSocket.instances = [];
    vi.stubGlobal('WebSocket', TestWebSocket);
  });

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders status history and preserves the failed status reason', async () => {
    vi.mocked(taskApi.getTask).mockResolvedValue({ task });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();

    expect(wrapper.text()).toContain('失败');
    expect(wrapper.text()).toContain('命令退出码为 1');
    expect(wrapper.text()).toContain('初始状态');
    expect(wrapper.text()).toContain('命令失败');
    expect(wrapper.text()).toContain('重新构建');
  });

  it('reloads task, logs and artifacts after the reused route changes taskId', async () => {
    const nextTask = {
      ...task,
      id: 'new-task-id',
      statusReason: '新任务原因',
      exitCode: 0,
      project: { ...task.project, name: '新项目' },
    };
    vi.mocked(taskApi.getTask)
      .mockResolvedValueOnce({ task })
      .mockResolvedValueOnce({ task: nextTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    mocks.route.params.taskId = 'new-task-id';
    mocks.route.fullPath = '/tasks/new-task-id';
    await flushPromises();

    expect(vi.mocked(taskApi.getTask)).toHaveBeenLastCalledWith('new-task-id');
    expect(vi.mocked(taskApi.readTaskLogs).mock.calls.at(-1)?.[0]).toBe('new-task-id');
    expect(vi.mocked(artifactApi.listTaskArtifacts).mock.calls.at(-1)?.[0]).toBe('new-task-id');
    expect(wrapper.text()).toContain('新项目');
  });

  it('does not let a delayed old task response replace the new route context', async () => {
    let resolveOld!: (value: { task: TaskDetail }) => void;
    const oldResponse = new Promise<{ task: TaskDetail }>((resolve) => {
      resolveOld = resolve;
    });
    const nextTask = {
      ...task,
      id: 'new-task-id',
      statusReason: '新任务原因',
      exitCode: 0,
      project: { ...task.project, name: '新项目' },
    };
    vi.mocked(taskApi.getTask)
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce({ task: nextTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    mocks.route.params.taskId = 'new-task-id';
    await flushPromises();
    resolveOld({ task });
    await flushPromises();

    expect(wrapper.text()).toContain('新项目');
    expect(wrapper.text()).not.toContain('命令退出码为 1');
  });

  it('closes the old log socket and subscribes the new task after route reuse', async () => {
    const nextTask = { ...task, id: 'new-task-id', project: { ...task.project, name: '新项目' } };
    vi.mocked(taskApi.getTask).mockResolvedValue({ task: nextTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'new-task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'new-task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();

    const oldSocket = TestWebSocket.instances[0];
    oldSocket.open();
    oldSocket.receive({ type: 'auth.ok' });
    expect(oldSocket.sent.some((value) => value.includes('task-id'))).toBe(true);

    mocks.route.params.taskId = 'new-task-id';
    mocks.route.fullPath = '/tasks/new-task-id';
    await flushPromises();

    expect(oldSocket.closeCalls).toBe(1);
    const newSocket = TestWebSocket.instances.at(-1);
    expect(newSocket).not.toBe(oldSocket);
    newSocket?.open();
    newSocket?.receive({ type: 'auth.ok' });
    expect(newSocket?.sent.some((value) => value.includes('new-task-id'))).toBe(true);
  });

  it('caps authentication-failure reconnects and refreshes at most once', async () => {
    vi.useFakeTimers();
    vi.mocked(taskApi.getTask).mockResolvedValue({ task });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });
    mocks.refreshSession.mockResolvedValue(true);

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = TestWebSocket.instances.at(-1);
      current?.open();
      current?.closeWithCode(1008);
      await flushPromises();
      vi.advanceTimersByTime(8_000);
      await flushPromises();
    }

    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(TestWebSocket.instances).toHaveLength(6);
    expect(wrapper.text()).toContain('实时日志连接不可用，请刷新页面重试');
  });

  it('restarts polling for a reused non-terminal task', async () => {
    vi.useFakeTimers();
    const nextTask: TaskDetail = {
      ...task,
      id: 'new-task-id',
      status: 'RUNNING',
      statusReason: '执行中',
      exitCode: null,
      finishedAt: null,
      project: { ...task.project, name: '新项目' },
    };
    vi.mocked(taskApi.getTask)
      .mockResolvedValueOnce({ task })
      .mockResolvedValue({ task: nextTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    mocks.route.params.taskId = 'new-task-id';
    await flushPromises();
    const callsBeforePolling = vi.mocked(taskApi.getTask).mock.calls.length;

    vi.advanceTimersByTime(2_500);
    await flushPromises();

    expect(vi.mocked(taskApi.getTask).mock.calls.length).toBeGreaterThan(callsBeforePolling);
    expect(vi.mocked(taskApi.getTask)).toHaveBeenLastCalledWith('new-task-id');
  });

  it('refreshes and renders artifacts once when polling observes success', async () => {
    vi.useFakeTimers();
    const runningTask: TaskDetail = {
      ...task,
      status: 'RUNNING',
      statusReason: '执行中',
      exitCode: null,
      finishedAt: null,
    };
    const succeededTask: TaskDetail = {
      ...runningTask,
      status: 'SUCCEEDED',
      statusReason: null,
      exitCode: 0,
      finishedAt: '2026-01-01T00:00:02.000Z',
    };
    vi.mocked(taskApi.getTask)
      .mockResolvedValueOnce({ task: runningTask })
      .mockResolvedValue({ task: succeededTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts)
      .mockResolvedValueOnce({ taskId: 'task-id', items: [], page: 1, pageSize: 20, total: 0 })
      .mockResolvedValueOnce({
        taskId: 'task-id',
        items: [
          {
            id: 'artifact-1',
            taskId: 'task-id',
            relativePath: 'build.zip',
            fileName: 'build.zip',
            size: '3',
            sha256: 'abc123',
            createdAt: '2026-01-01T00:00:02.000Z',
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    expect(vi.mocked(artifactApi.listTaskArtifacts)).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_500);
    await flushPromises();

    expect(vi.mocked(taskApi.getTask)).toHaveBeenLastCalledWith('task-id');
    expect(vi.mocked(artifactApi.listTaskArtifacts)).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('build.zip');
    expect(wrapper.text()).toContain('成功');

    vi.advanceTimersByTime(7_500);
    await flushPromises();
    expect(vi.mocked(artifactApi.listTaskArtifacts)).toHaveBeenCalledTimes(2);
  });

  it('does not let delayed artifacts from an old route context replace the new task', async () => {
    let resolveOldArtifacts!: (value: ArtifactPage) => void;
    const oldArtifacts = new Promise<ArtifactPage>((resolve) => {
      resolveOldArtifacts = resolve;
    });
    const nextTask: TaskDetail = {
      ...task,
      id: 'new-task-id',
      project: { ...task.project, name: '新项目' },
    };
    vi.mocked(taskApi.getTask)
      .mockResolvedValueOnce({ task })
      .mockResolvedValueOnce({ task: nextTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts)
      .mockReturnValueOnce(oldArtifacts)
      .mockResolvedValueOnce({
        taskId: 'new-task-id',
        items: [
          {
            id: 'new-artifact',
            taskId: 'new-task-id',
            relativePath: 'new-build.zip',
            fileName: 'new-build.zip',
            size: '5',
            sha256: 'def456',
            createdAt: '2026-01-01T00:00:03.000Z',
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    mocks.route.params.taskId = 'new-task-id';
    mocks.route.fullPath = '/tasks/new-task-id';
    await flushPromises();
    expect(wrapper.text()).toContain('new-build.zip');

    resolveOldArtifacts({
      taskId: 'task-id',
      items: [
        {
          id: 'old-artifact',
          taskId: 'task-id',
          relativePath: 'old-build.zip',
          fileName: 'old-build.zip',
          size: '4',
          sha256: 'old123',
          createdAt: '2026-01-01T00:00:02.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    await flushPromises();

    expect(wrapper.text()).toContain('new-build.zip');
    expect(wrapper.text()).not.toContain('old-build.zip');
  });

  it('does not poll after switching to a terminal task', async () => {
    vi.useFakeTimers();
    const nextTask: TaskDetail = {
      ...task,
      id: 'new-task-id',
      status: 'SUCCEEDED',
      statusReason: null,
      exitCode: 0,
      project: { ...task.project, name: '新项目' },
    };
    vi.mocked(taskApi.getTask)
      .mockResolvedValueOnce({ task: { ...task, status: 'RUNNING', statusReason: '执行中' } })
      .mockResolvedValueOnce({ task: nextTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    mocks.route.params.taskId = 'new-task-id';
    await flushPromises();
    const callsAfterSwitch = vi.mocked(taskApi.getTask).mock.calls.length;

    vi.advanceTimersByTime(2_500);
    await flushPromises();

    expect(vi.mocked(taskApi.getTask).mock.calls.length).toBe(callsAfterSwitch);
  });

  it('does not start polling or WebSocket work when unmounted during loading', async () => {
    let resolveTask!: (value: { task: TaskDetail }) => void;
    let resolveLogs!: (value: {
      taskId: string;
      offset: number;
      nextOffset: number;
      size: number;
      eof: boolean;
      entries: [];
    }) => void;
    let resolveArtifacts!: (value: {
      taskId: string;
      items: [];
      page: number;
      pageSize: number;
      total: number;
    }) => void;
    vi.mocked(taskApi.getTask).mockReturnValue(
      new Promise((resolve) => {
        resolveTask = resolve;
      }),
    );
    vi.mocked(taskApi.readTaskLogs).mockReturnValue(
      new Promise((resolve) => {
        resolveLogs = resolve;
      }),
    );
    vi.mocked(artifactApi.listTaskArtifacts).mockReturnValue(
      new Promise((resolve) => {
        resolveArtifacts = resolve;
      }),
    );

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    wrapper.unmount();
    resolveTask({ task });
    resolveLogs({ taskId: 'task-id', offset: 0, nextOffset: 0, size: 0, eof: true, entries: [] });
    resolveArtifacts({ taskId: 'task-id', items: [], page: 1, pageSize: 20, total: 0 });
    await flushPromises();

    expect(TestWebSocket.instances).toHaveLength(0);
  });

  it('shows the interactive input panel and sends one line only after control is acquired', async () => {
    const interactiveTask: TaskDetail = {
      ...task,
      status: 'RUNNING',
      statusReason: '执行中',
      interactiveInputEnabled: true,
      finishedAt: null,
      exitCode: null,
      agent: { ...task.agent, status: 'ONLINE' },
      buildTemplate: {
        ...task.buildTemplate,
        agent: { ...task.buildTemplate.agent, status: 'ONLINE' },
      },
    };
    vi.mocked(taskApi.getTask).mockResolvedValue({ task: interactiveTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();

    expect(wrapper.text()).toContain('交互输入');
    const current = TestWebSocket.instances.at(-1);
    expect(current).toBeDefined();
    current?.open();
    current?.receive({ type: 'auth.ok' });
    current?.receive({
      type: 'task.input.state',
      taskId: 'task-id',
      enabled: true,
      writable: false,
      controlledByCurrentSocket: false,
      busy: false,
    });
    await flushPromises();

    const acquire = wrapper
      .findAll('button')
      .find((button) => button.text().includes('获取控制权'));
    expect(acquire).toBeDefined();
    await acquire?.trigger('click');
    expect(current?.sent.some((value) => value.includes('task.input.acquire'))).toBe(true);

    current?.receive({
      type: 'task.input.state',
      taskId: 'task-id',
      enabled: true,
      writable: true,
      controlledByCurrentSocket: true,
      busy: false,
    });
    await flushPromises();
    const input = wrapper.find('input[placeholder="输入一行文本，按 Enter 发送"]');
    await input.setValue('hello');
    expect(wrapper.text()).toContain('5 / 4096 字节');
    const send = wrapper.findAll('button').find((button) => button.text() === '发送');
    expect(send).toBeDefined();
    await send?.trigger('click');
    const sentInput = current?.sent.find((value) => value.includes('task.input.send'));
    expect(sentInput).toBeDefined();
    expect(JSON.parse(sentInput as string)).toMatchObject({
      type: 'task.input.send',
      taskId: 'task-id',
      text: 'hello',
      sensitive: false,
    });
    expect((input.element as HTMLInputElement).value).toBe('');

    current?.receive({
      type: 'task.input.state',
      taskId: 'task-id',
      enabled: true,
      writable: true,
      controlledByCurrentSocket: true,
      busy: false,
    });
    current?.receive({
      type: 'task.input.result',
      taskId: 'task-id',
      inputId: 'input-id',
      status: 'REJECTED',
      code: 'TASK_INPUT_DELIVERY_TIMEOUT',
      message: '输入发送超时',
    });
    await flushPromises();
    expect((input.element as HTMLInputElement).disabled).toBe(false);
    expect((send?.element as HTMLButtonElement).disabled).toBe(false);
    expect(current?.sent.filter((value) => value.includes('task.input.send'))).toHaveLength(1);
  });

  it('validates interactive input using UTF-8 bytes and blocks unsafe or oversized text', async () => {
    const interactiveTask: TaskDetail = {
      ...task,
      status: 'RUNNING',
      statusReason: '执行中',
      interactiveInputEnabled: true,
      finishedAt: null,
      exitCode: null,
      agent: { ...task.agent, status: 'ONLINE' },
      buildTemplate: {
        ...task.buildTemplate,
        agent: { ...task.buildTemplate.agent, status: 'ONLINE' },
      },
    };
    vi.mocked(taskApi.getTask).mockResolvedValue({ task: interactiveTask });
    vi.mocked(taskApi.readTaskLogs).mockResolvedValue({
      taskId: 'task-id',
      offset: 0,
      nextOffset: 0,
      size: 0,
      eof: true,
      entries: [],
    });
    vi.mocked(artifactApi.listTaskArtifacts).mockResolvedValue({
      taskId: 'task-id',
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    const wrapper = mount(TaskDetailView, { global: { plugins: [ElementPlus] } });
    mountedWrappers.push(wrapper);
    await flushPromises();
    const current = TestWebSocket.instances.at(-1);
    current?.open();
    current?.receive({ type: 'auth.ok' });
    current?.receive({
      type: 'task.input.state',
      taskId: 'task-id',
      enabled: true,
      writable: true,
      controlledByCurrentSocket: true,
      busy: false,
    });
    await flushPromises();

    const input = wrapper.find('input[placeholder="输入一行文本，按 Enter 发送"]');
    await input.setValue('中'.repeat(1_366));
    await flushPromises();

    expect(wrapper.text()).toContain('4098 / 4096 字节');
    expect(wrapper.text()).toContain('输入内容不能超过 4096 字节');
    expect((input.element as HTMLInputElement).disabled).toBe(false);
    const send = wrapper.findAll('button').find((button) => button.text() === '发送');
    expect((send?.element as HTMLButtonElement).disabled).toBe(true);
    expect(current?.sent.some((value) => value.includes('task.input.send'))).toBe(false);

    await input.setValue('ok');
    await flushPromises();
    expect(wrapper.text()).toContain('2 / 4096 字节');
    expect((input.element as HTMLInputElement).disabled).toBe(false);
    expect((send?.element as HTMLButtonElement).disabled).toBe(false);

    await input.setValue('line\u0001next');
    await flushPromises();
    expect(wrapper.text()).toContain('输入只能包含单行文本，不能包含控制字符');
    expect((input.element as HTMLInputElement).disabled).toBe(false);
    expect((send?.element as HTMLButtonElement).disabled).toBe(true);

    await input.setValue('safe again');
    await flushPromises();
    expect((send?.element as HTMLButtonElement).disabled).toBe(false);
  });
});
