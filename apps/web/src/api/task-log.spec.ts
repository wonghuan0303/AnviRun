import { describe, expect, it } from 'vitest';

import { clientLogWebSocketUrl, parseClientLogEvent } from './task-log';

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
});
