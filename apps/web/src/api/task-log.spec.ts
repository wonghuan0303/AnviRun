import { describe, expect, it } from 'vitest';

import {
  clientLogWebSocketUrl,
  parseClientLogEvent,
  parseTaskInputResult,
  parseTaskInputState,
} from './task-log';

describe('client task log protocol helpers', () => {
  it('parses only safe task.log events', () => {
    expect(
      parseClientLogEvent({
        type: 'task.log',
        taskId: 'task-id',
        offset: 0,
        nextOffset: 20,
        entry: { sequence: 1, stream: 'stdout', chunk: '<text>', emittedAt: 'now' },
      }),
    ).toMatchObject({ offset: 0, nextOffset: 20, entry: { chunk: '<text>' } });
    expect(parseClientLogEvent({ type: 'task.log', entry: {} })).toBeUndefined();
  });

  it('builds a WebSocket endpoint without putting an access token in the URL', () => {
    const url = clientLogWebSocketUrl();
    expect(url).toMatch(/^wss?:\/\//);
    expect(url).toContain('/ws/client');
    expect(url).not.toContain('token');
  });

  it('parses input state and result without accepting input text', () => {
    expect(
      parseTaskInputState({
        type: 'task.input.state',
        taskId: 'task-id',
        enabled: true,
        writable: true,
        controlledByCurrentSocket: true,
        busy: false,
        reason: 'TASK_INPUT_BUSY',
        requestId: 'request-id',
      }),
    ).toMatchObject({ taskId: 'task-id', writable: true, reason: 'TASK_INPUT_BUSY' });
    expect(
      parseTaskInputResult({
        type: 'task.input.result',
        taskId: 'task-id',
        inputId: 'input-id',
        status: 'DELIVERED',
        message: '输入已写入 Agent 进程',
        text: 'must not be copied',
      }),
    ).not.toHaveProperty('text');
    expect(parseTaskInputResult({ type: 'task.input.result', status: 'UNKNOWN' })).toBeUndefined();
  });
});
