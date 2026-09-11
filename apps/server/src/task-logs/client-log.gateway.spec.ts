import { WebSocket } from 'ws';

import { ClientLogGateway } from './client-log.gateway';

const taskId = '11111111-1111-4111-8111-111111111111';
const inputId = '22222222-2222-4222-8222-222222222222';
type TestSocket = WebSocket & { sent: string[] };

type GatewayInternals = {
  states: Map<
    WebSocket,
    {
      actor?: { id: string };
      subscriptions: Map<string, { taskId: string; unsubscribe: () => void }>;
    }
  >;
  sendInput: (
    socket: WebSocket,
    state: { actor?: { id: string }; subscriptions: Map<string, unknown> },
    message: Record<string, unknown>,
  ) => Promise<void>;
  broadcastTaskInputState: (taskId: string) => void;
};

function socket(): TestSocket {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    sent,
    send: jest.fn((value: string) => sent.push(value)),
    close: jest.fn(),
    terminate: jest.fn(),
  } as never;
}

describe('ClientLogGateway task input handling', () => {
  function createGateway(taskInput: unknown): ClientLogGateway {
    const httpServer = { on: jest.fn(), off: jest.fn() };
    return new ClientLogGateway(
      { httpAdapter: { getHttpServer: () => httpServer } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn(() => taskInput) } as never,
    );
  }

  it('always returns a safe rejection when task input handling throws', async () => {
    const taskInput = {
      send: jest.fn().mockRejectedValue(new Error('delivery failed')),
      getState: jest.fn().mockResolvedValue({
        taskId,
        enabled: true,
        writable: true,
        controlledByCurrentSocket: true,
        busy: false,
      }),
    };
    const gateway = createGateway(taskInput);
    const currentSocket = socket();
    const state = { actor: { id: 'actor-id' }, subscriptions: new Map() };

    const internals = gateway as unknown as GatewayInternals;
    await internals.sendInput(currentSocket, state, {
      taskId,
      inputId,
      text: 'input',
      sensitive: false,
    });

    const messages = currentSocket.sent.map((value) => JSON.parse(value));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'task.input.state',
          taskId,
          writable: true,
          controlledByCurrentSocket: true,
        }),
        expect.objectContaining({
          type: 'task.input.result',
          taskId,
          inputId,
          status: 'REJECTED',
          code: 'TASK_INPUT_DELIVERY_FAILED',
        }),
      ]),
    );
  });

  it('forwards a temporary delivery error without replacing the current writable state', async () => {
    const taskInput = {
      send: jest.fn().mockResolvedValue({
        result: { status: 'REJECTED', code: 'TASK_INPUT_DELIVERY_TIMEOUT' },
        state: {
          taskId,
          enabled: true,
          writable: true,
          controlledByCurrentSocket: true,
          busy: false,
        },
      }),
    };
    const gateway = createGateway(taskInput);
    const currentSocket = socket();
    const state = { actor: { id: 'actor-id' }, subscriptions: new Map() };

    const internals = gateway as unknown as GatewayInternals;
    await internals.sendInput(currentSocket, state, {
      taskId,
      inputId,
      text: 'input',
      sensitive: false,
    });

    const messages = currentSocket.sent.map((value) => JSON.parse(value));
    expect(messages).toEqual([
      expect.objectContaining({
        type: 'task.input.state',
        taskId,
        writable: true,
        controlledByCurrentSocket: true,
      }),
      expect.objectContaining({
        type: 'task.input.result',
        taskId,
        inputId,
        status: 'REJECTED',
        code: 'TASK_INPUT_DELIVERY_TIMEOUT',
      }),
    ]);
  });

  it('broadcasts a socket-specific state to every subscribed window', async () => {
    const firstSocket = socket();
    const secondSocket = socket();
    const taskInput = {
      getState: jest.fn(async (_actor: unknown, currentSocket: WebSocket) => ({
        taskId,
        enabled: true,
        writable: currentSocket === firstSocket,
        controlledByCurrentSocket: currentSocket === firstSocket,
        busy: false,
        ...(currentSocket === firstSocket ? {} : { reason: 'TASK_INPUT_BUSY' }),
      })),
    };
    const gateway = createGateway(taskInput);
    const subscriptions = new Map([[taskId, { taskId, unsubscribe: jest.fn() }]]);
    const internals = gateway as unknown as GatewayInternals;
    internals.states.set(firstSocket, {
      actor: { id: 'first-actor' },
      subscriptions,
    });
    internals.states.set(secondSocket, {
      actor: { id: 'second-actor' },
      subscriptions,
    });

    internals.broadcastTaskInputState(taskId);
    await Promise.resolve();

    expect(firstSocket.sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ type: 'task.input.state', writable: true }),
    ]);
    expect(secondSocket.sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({
        type: 'task.input.state',
        writable: false,
        reason: 'TASK_INPUT_BUSY',
      }),
    ]);
  });

  it('broadcasts a remembered stdin-closed state to every subscribed window', async () => {
    const firstSocket = socket();
    const secondSocket = socket();
    const taskInput = {
      getState: jest.fn().mockResolvedValue({
        taskId,
        enabled: true,
        writable: false,
        controlledByCurrentSocket: false,
        busy: false,
        reason: 'TASK_INPUT_STDIN_CLOSED',
      }),
    };
    const gateway = createGateway(taskInput);
    const subscriptions = new Map([[taskId, { taskId, unsubscribe: jest.fn() }]]);
    const internals = gateway as unknown as GatewayInternals;
    internals.states.set(firstSocket, {
      actor: { id: 'first-actor' },
      subscriptions,
    });
    internals.states.set(secondSocket, {
      actor: { id: 'second-actor' },
      subscriptions,
    });

    internals.broadcastTaskInputState(taskId);
    await Promise.resolve();

    for (const currentSocket of [firstSocket, secondSocket]) {
      expect(currentSocket.sent.map((value) => JSON.parse(value))).toEqual([
        expect.objectContaining({
          type: 'task.input.state',
          taskId,
          writable: false,
          controlledByCurrentSocket: false,
          reason: 'TASK_INPUT_STDIN_CLOSED',
        }),
      ]);
    }
  });
});
