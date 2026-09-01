import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('adds a stable result and drops secret-bearing metadata keys', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const service = new AuditService({ auditLog: { create } } as never);

    await service.record({
      action: 'TASK_CANCEL_REQUESTED',
      resourceType: 'BuildTask',
      resourceId: 'task-id',
      metadata: {
        taskId: 'task-id',
        config: 'must-not-be-recorded',
        leaseToken: 'must-not-be-recorded',
        storagePath: 'must-not-be-recorded',
      },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: undefined,
        action: 'TASK_CANCEL_REQUESTED',
        resourceType: 'BuildTask',
        resourceId: 'task-id',
        requestId: undefined,
        metadata: { result: 'SUCCESS', taskId: 'task-id' },
      },
    });
  });

  it('marks rejected actions as failures without copying arbitrary metadata', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const service = new AuditService({ auditLog: { create } } as never);

    await service.record({
      action: 'AUTH_LOGIN_FAILED',
      resourceType: 'User',
      resourceId: 'unknown',
      metadata: { outcome: 'rejected', password: 'secret' },
    });

    expect(create.mock.calls[0]?.[0].data.metadata).toEqual({
      result: 'FAILURE',
      outcome: 'rejected',
    });
  });
});
