import { AgentStatus, BuildTaskStatus } from '@prisma/client';
import type { TaskInputAckMessage, TaskInputMessage } from '@anvilrun/contracts';

import { TaskQueueService } from './task-queue.service';

const taskId = '11111111-1111-4111-8111-111111111111';
const inputId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const leaseToken = 'lease-token-000001';

function createQueue(overrides: { send?: jest.Mock; task?: Record<string, unknown> } = {}): {
  queue: TaskQueueService;
  send: jest.Mock;
  findUnique: jest.Mock;
} {
  const send = overrides.send ?? jest.fn(() => true);
  const findUnique = jest.fn().mockResolvedValue(
    overrides.task ?? {
      id: taskId,
      agentId,
      status: BuildTaskStatus.RUNNING,
      interactiveInputEnabled: true,
      project: { deletedAt: null },
      agent: { activeTaskId: taskId, enabled: true, status: AgentStatus.ONLINE },
    },
  );
  const prisma = {
    buildTask: {
      findUnique,
    },
  };
  const registry = {
    isReady: jest.fn(() => true),
    hasCapability: jest.fn(() => true),
    send,
  };
  const queue = new TaskQueueService(
    prisma as never,
    registry as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const internals = queue as unknown as {
    activeLeaseTokens: Map<string, string>;
  };
  internals.activeLeaseTokens.set(taskId, leaseToken);
  return { queue, send, findUnique };
}

function ack(overrides: Partial<TaskInputAckMessage['payload']> = {}): TaskInputAckMessage {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    type: 'task.input.ack',
    timestamp: '2026-09-11T00:00:00.000Z',
    protocolVersion: 1,
    payload: {
      taskId,
      leaseToken,
      inputId,
      accepted: true,
      acknowledgedAt: '2026-09-11T00:00:00.000Z',
      ...overrides,
    },
  };
}

describe('TaskQueueService task input delivery', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('notifies terminal listeners after task completion and supports unsubscribe', async () => {
    const { queue } = createQueue();
    const listener = jest.fn();
    const unsubscribe = queue.onTaskTerminal(listener);
    const onAgentReady = jest.spyOn(queue, 'onAgentReady').mockResolvedValue(undefined);

    await queue.onTaskCompleted(agentId, taskId);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(taskId);
    expect(onAgentReady).toHaveBeenCalledWith(agentId);

    unsubscribe();
    await queue.onTaskCompleted(agentId, taskId);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('delivers once and accepts only a matching Agent ACK', async () => {
    const { queue, send } = createQueue();
    const delivery = queue.sendTaskInput(taskId, inputId, 'input', false);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][1] as TaskInputMessage;
    expect(message.payload.inputId).toBe(inputId);
    expect(queue.handleTaskInputAck(agentId, ack({ leaseToken: 'wrong-lease' }))).toBe(false);
    expect(queue.handleTaskInputAck('other-agent', ack())).toBe(false);
    expect(
      queue.handleTaskInputAck(agentId, ack({ taskId: '55555555-5555-4555-8555-555555555555' })),
    ).toBe(false);
    expect(
      queue.handleTaskInputAck(agentId, ack({ inputId: '66666666-6666-4666-8666-666666666666' })),
    ).toBe(false);
    expect(queue.handleTaskInputAck(agentId, ack())).toBe(true);
    await expect(delivery).resolves.toEqual({ status: 'DELIVERED' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects a deleted project before sending to the Agent', async () => {
    const send = jest.fn(() => true);
    const { queue } = createQueue({
      send,
      task: {
        id: taskId,
        agentId,
        status: BuildTaskStatus.RUNNING,
        interactiveInputEnabled: true,
        project: { deletedAt: new Date() },
        agent: { activeTaskId: taskId, enabled: true, status: AgentStatus.ONLINE },
      },
    });

    await expect(queue.sendTaskInput(taskId, inputId, 'input', false)).resolves.toEqual({
      status: 'REJECTED',
      code: 'TASK_INPUT_NOT_ENABLED',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('times out an unacknowledged input once without retrying', async () => {
    jest.useFakeTimers();
    const { queue, send } = createQueue();
    const delivery = queue.sendTaskInput(taskId, inputId, 'input', false);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5_000);
    await expect(delivery).resolves.toEqual({
      status: 'REJECTED',
      code: 'TASK_INPUT_DELIVERY_TIMEOUT',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
