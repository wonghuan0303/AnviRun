import { AgentStatus, BuildTaskStatus } from '@prisma/client';
import { WebSocket } from 'ws';

import { TaskInputService } from './task-input.service';

const taskId = '11111111-1111-4111-8111-111111111111';
const inputId = '22222222-2222-4222-8222-222222222222';
const actor = { id: 'actor-id', role: 'USER', status: 'ACTIVE' } as never;

function socket(): WebSocket {
  return { readyState: WebSocket.OPEN } as WebSocket;
}

describe('TaskInputService', () => {
  let prisma: { buildTask: { findFirst: jest.Mock } };
  let authorization: { taskScope: jest.Mock };
  let registry: { isReady: jest.Mock; hasCapability: jest.Mock };
  let queue: { sendTaskInput: jest.Mock; onTaskTerminal: jest.Mock };
  let taskTerminalListener: ((taskId: string) => void) | undefined;
  let audit: { record: jest.Mock };
  let service: TaskInputService;

  beforeEach(() => {
    prisma = { buildTask: { findFirst: jest.fn() } };
    authorization = { taskScope: jest.fn(() => ({ id: taskId })) };
    registry = {
      isReady: jest.fn(() => true),
      hasCapability: jest.fn(() => true),
    };
    taskTerminalListener = undefined;
    queue = {
      sendTaskInput: jest.fn().mockResolvedValue({ status: 'DELIVERED' }),
      onTaskTerminal: jest.fn((listener: (terminalTaskId: string) => void) => {
        taskTerminalListener = listener;
        return jest.fn();
      }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new TaskInputService(
      prisma as never,
      authorization as never,
      registry as never,
      queue as never,
      audit as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function setTask(overrides: Partial<Record<string, unknown>> = {}): void {
    prisma.buildTask.findFirst.mockResolvedValue({
      id: taskId,
      interactiveInputEnabled: true,
      status: BuildTaskStatus.RUNNING,
      agentId: 'agent-id',
      agent: {
        enabled: true,
        status: AgentStatus.ONLINE,
        activeTaskId: taskId,
      },
      ...overrides,
    });
  }

  it('grants only one socket control of a task at a time', async () => {
    setTask();
    const first = socket();
    const second = socket();

    await expect(service.acquire(actor, first, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: true,
      writable: true,
    });
    await expect(service.acquire(actor, second, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: false,
      writable: false,
      reason: 'TASK_INPUT_BUSY',
    });

    await service.release(actor, first, taskId);
    await expect(service.acquire(actor, second, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: true,
      writable: true,
    });
  });

  it('broadcasts control changes and releases an idle controller', async () => {
    jest.useFakeTimers();
    setTask();
    const first = socket();
    const second = socket();
    const stateChanged = jest.fn();
    service.onStateChange(stateChanged);

    await service.acquire(actor, first, taskId);
    expect(stateChanged).toHaveBeenLastCalledWith(taskId);

    stateChanged.mockClear();
    jest.advanceTimersByTime(5 * 60_000 + 1);
    expect(stateChanged).toHaveBeenCalledWith(taskId);

    await expect(service.acquire(actor, second, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: true,
      writable: true,
    });
  });

  it('releases a disconnected controller so another socket can acquire', async () => {
    setTask();
    const first = socket();
    const second = socket();
    await service.acquire(actor, first, taskId);

    service.releaseSocket(first);
    await expect(service.acquire(actor, second, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: true,
      writable: true,
    });
  });

  it('rejects non-running or disabled input before using the delivery queue', async () => {
    setTask({ status: BuildTaskStatus.PREPARING });
    const preparing = await service.getState(actor, socket(), taskId);
    expect(preparing).toMatchObject({
      enabled: true,
      writable: false,
      reason: 'TASK_INPUT_NOT_RUNNING',
    });

    setTask({ interactiveInputEnabled: false });
    const disabled = await service.getState(actor, socket(), taskId);
    expect(disabled).toMatchObject({
      enabled: false,
      writable: false,
      reason: 'TASK_INPUT_NOT_ENABLED',
    });
    expect(queue.sendTaskInput).not.toHaveBeenCalled();
  });

  it('delivers safe input only after control is acquired and never audits its text', async () => {
    setTask();
    const currentSocket = socket();
    await service.acquire(actor, currentSocket, taskId);

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'secret-value', true),
    ).resolves.toMatchObject({ result: { status: 'DELIVERED' } });
    expect(queue.sendTaskInput).toHaveBeenCalledWith(taskId, inputId, 'secret-value', true);
    const auditCalls = audit.record.mock.calls.map(([value]) => JSON.stringify(value));
    expect(auditCalls.join('\n')).not.toContain('secret-value');
    expect(auditCalls.join('\n')).toContain('byteLength');
  });

  it('keeps a delivered result when audit persistence fails and never repeats delivery', async () => {
    setTask();
    const currentSocket = socket();
    await service.acquire(actor, currentSocket, taskId);
    audit.record.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'accepted input', false),
    ).resolves.toMatchObject({ result: { status: 'DELIVERED' } });
    expect(queue.sendTaskInput).toHaveBeenCalledTimes(1);
  });

  it('returns a safe failure when queue delivery fails', async () => {
    setTask();
    const currentSocket = socket();
    await service.acquire(actor, currentSocket, taskId);
    queue.sendTaskInput.mockRejectedValue(new Error('delivery unavailable'));

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'input', false),
    ).resolves.toMatchObject({
      result: { status: 'REJECTED', code: 'TASK_INPUT_DELIVERY_FAILED' },
    });
  });

  it('keeps the control state writable after rate limiting and allows a later retry', async () => {
    jest.useFakeTimers();
    setTask();
    const currentSocket = socket();
    await service.acquire(actor, currentSocket, taskId);

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'first', false),
    ).resolves.toMatchObject({ result: { status: 'DELIVERED' } });

    await expect(
      service.send(
        actor,
        currentSocket,
        taskId,
        '33333333-3333-4333-8333-333333333333',
        'too soon',
        false,
      ),
    ).resolves.toMatchObject({
      result: { status: 'REJECTED', code: 'TASK_INPUT_RATE_LIMITED' },
      state: { controlledByCurrentSocket: true, writable: true, busy: false },
    });

    jest.advanceTimersByTime(251);
    await expect(
      service.send(
        actor,
        currentSocket,
        taskId,
        '33333333-3333-4333-8333-333333333333',
        'retry',
        false,
      ),
    ).resolves.toMatchObject({ result: { status: 'DELIVERED' } });
    expect(queue.sendTaskInput).toHaveBeenCalledTimes(2);
  });

  it('keeps the control state writable after a temporary delivery failure', async () => {
    jest.useFakeTimers();
    setTask();
    const currentSocket = socket();
    await service.acquire(actor, currentSocket, taskId);
    queue.sendTaskInput
      .mockResolvedValueOnce({ status: 'REJECTED', code: 'TASK_INPUT_DELIVERY_FAILED' })
      .mockResolvedValueOnce({ status: 'DELIVERED' });

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'first attempt', false),
    ).resolves.toMatchObject({
      result: { status: 'REJECTED', code: 'TASK_INPUT_DELIVERY_FAILED' },
      state: { controlledByCurrentSocket: true, writable: true, busy: false },
    });

    jest.advanceTimersByTime(251);
    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'retry attempt', false),
    ).resolves.toMatchObject({ result: { status: 'DELIVERED' } });
    expect(queue.sendTaskInput).toHaveBeenCalledTimes(2);
  });

  it('keeps the control state writable after a delivery timeout without retrying automatically', async () => {
    jest.useFakeTimers();
    setTask();
    const currentSocket = socket();
    await service.acquire(actor, currentSocket, taskId);
    queue.sendTaskInput
      .mockResolvedValueOnce({ status: 'REJECTED', code: 'TASK_INPUT_DELIVERY_TIMEOUT' })
      .mockResolvedValueOnce({ status: 'DELIVERED' });

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'timed out', false),
    ).resolves.toMatchObject({
      result: { status: 'REJECTED', code: 'TASK_INPUT_DELIVERY_TIMEOUT' },
      state: { controlledByCurrentSocket: true, writable: true, busy: false },
    });
    expect(queue.sendTaskInput).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(251);
    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'manual retry', false),
    ).resolves.toMatchObject({ result: { status: 'DELIVERED' } });
    expect(queue.sendTaskInput).toHaveBeenCalledTimes(2);
  });

  it('remembers Agent-confirmed stdin closure until the task leaves RUNNING', async () => {
    setTask();
    const currentSocket = socket();
    const otherSocket = socket();
    let lastBroadcast: Promise<unknown> = Promise.resolve();
    const stateChangeCount = jest.fn();
    service.onStateChange((changedTaskId) => {
      stateChangeCount();
      lastBroadcast = service.getState(actor, otherSocket, changedTaskId);
    });
    await service.acquire(actor, currentSocket, taskId);
    queue.sendTaskInput.mockResolvedValue({
      status: 'REJECTED',
      code: 'TASK_INPUT_STDIN_CLOSED',
    });

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'closed by Agent', false),
    ).resolves.toMatchObject({
      result: { status: 'REJECTED', code: 'TASK_INPUT_STDIN_CLOSED' },
      state: {
        controlledByCurrentSocket: false,
        writable: false,
        reason: 'TASK_INPUT_STDIN_CLOSED',
      },
    });
    await expect(lastBroadcast).resolves.toMatchObject({
      controlledByCurrentSocket: false,
      writable: false,
      reason: 'TASK_INPUT_STDIN_CLOSED',
    });

    const stateChangesAfterClosure = stateChangeCount.mock.calls.length;
    prisma.buildTask.findFirst.mockResolvedValue(null);
    await expect(service.getState(actor, otherSocket, taskId)).rejects.toThrow('task not found');
    await expect(service.acquire(actor, otherSocket, taskId)).rejects.toThrow('task not found');
    expect(stateChangeCount).toHaveBeenCalledTimes(stateChangesAfterClosure);
    expect(queue.sendTaskInput).toHaveBeenCalledTimes(1);

    setTask();
    await expect(service.getState(actor, currentSocket, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: false,
      writable: false,
      reason: 'TASK_INPUT_STDIN_CLOSED',
    });
    await expect(service.acquire(actor, otherSocket, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: false,
      writable: false,
      reason: 'TASK_INPUT_STDIN_CLOSED',
    });
    await expect(
      service.send(
        actor,
        otherSocket,
        taskId,
        '33333333-3333-4333-8333-333333333333',
        'retry',
        false,
      ),
    ).resolves.toMatchObject({
      result: { status: 'REJECTED', code: 'TASK_INPUT_STDIN_CLOSED' },
    });
    expect(queue.sendTaskInput).toHaveBeenCalledTimes(1);

    setTask({
      status: BuildTaskStatus.SUCCEEDED,
      agent: { enabled: true, status: AgentStatus.ONLINE, activeTaskId: null },
    });
    await expect(service.getState(actor, otherSocket, taskId)).resolves.toMatchObject({
      writable: false,
      reason: 'TASK_INPUT_NOT_RUNNING',
    });
    setTask();
    await expect(service.acquire(actor, otherSocket, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: true,
      writable: true,
    });

    expect(taskTerminalListener).toBeDefined();
    taskTerminalListener?.(taskId);
    taskTerminalListener?.(taskId);
    await expect(service.getState(actor, otherSocket, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: false,
      writable: false,
    });

    service.onModuleDestroy();
    const internals = service as unknown as {
      controllers: Map<string, unknown>;
      stdinClosedTasks: Set<string>;
    };
    expect(internals.controllers.size).toBe(0);
    expect(internals.stdinClosedTasks.size).toBe(0);
  });

  it('releases the controller and blocks sending after stdin closes', async () => {
    setTask();
    const currentSocket = socket();
    await service.acquire(actor, currentSocket, taskId);
    setTask({ agent: { enabled: true, status: AgentStatus.ONLINE, activeTaskId: null } });

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'closed channel', false),
    ).resolves.toMatchObject({
      result: { status: 'REJECTED', code: 'TASK_INPUT_STDIN_CLOSED' },
      state: {
        controlledByCurrentSocket: false,
        writable: false,
        reason: 'TASK_INPUT_STDIN_CLOSED',
      },
    });
    expect(queue.sendTaskInput).not.toHaveBeenCalled();
    await expect(service.getState(actor, currentSocket, taskId)).resolves.toMatchObject({
      controlledByCurrentSocket: false,
      writable: false,
      reason: 'TASK_INPUT_STDIN_CLOSED',
    });
  });

  it('does not acquire or forward input for an unsupported Agent', async () => {
    setTask();
    registry.hasCapability.mockReturnValue(false);

    await expect(service.acquire(actor, socket(), taskId)).resolves.toMatchObject({
      writable: false,
      reason: 'TASK_INPUT_AGENT_UNSUPPORTED',
    });
    expect(queue.sendTaskInput).not.toHaveBeenCalled();
  });

  it('rejects control characters and overlong UTF-8 input without forwarding it', async () => {
    setTask();
    const currentSocket = socket();
    await service.acquire(actor, currentSocket, taskId);

    await expect(
      service.send(actor, currentSocket, taskId, inputId, 'line\nnext', false),
    ).resolves.toMatchObject({ result: { status: 'REJECTED', code: 'TASK_INPUT_INVALID' } });
    await expect(
      service.send(
        actor,
        currentSocket,
        taskId,
        '33333333-3333-4333-8333-333333333333',
        '中'.repeat(2049),
        false,
      ),
    ).resolves.toMatchObject({ result: { status: 'REJECTED', code: 'TASK_INPUT_TOO_LARGE' } });
    expect(queue.sendTaskInput).not.toHaveBeenCalled();
  });
});
