import { describe, expect, it } from 'vitest';
import { validateProtocolMessage } from './validate';

describe('T2.1 agent hello optional identity contract', () => {
  it('allows hello.agentId to be omitted or null', () => {
    const base = {
      id: 'hello-message',
      type: 'agent.hello',
      timestamp: '2026-08-25T00:00:00Z',
      protocolVersion: 1,
      payload: {
        agentVersion: '2.1.0',
        hostname: 'builder',
        os: 'linux',
        arch: 'x86_64',
        workspaceRoot: '/workspace',
      },
    };
    expect(validateProtocolMessage(base).ok).toBe(true);
    expect(
      validateProtocolMessage({ ...base, payload: { ...base.payload, agentId: null } }).ok,
    ).toBe(true);
  });

  it('allows an active task to report an empty acknowledged log prefix', () => {
    const message = {
      id: 'hello-recovery-message',
      type: 'agent.hello',
      timestamp: '2026-08-25T00:00:00Z',
      protocolVersion: 1,
      payload: {
        agentId: 'agent-01',
        agentVersion: '2.1.0',
        hostname: 'builder',
        os: 'linux',
        arch: 'x86_64',
        workspaceRoot: '/workspace',
        currentTask: {
          taskId: 'task-01',
          leaseToken: 'lease-token-000001',
          status: 'PREPARING',
          lastLogSequence: 0,
        },
      },
    };
    expect(validateProtocolMessage(message).ok).toBe(true);
  });
});
