import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import { cancelTask, createTask, listProjectTasks, readTaskLogs, rebuildTask } from './tasks';

vi.mock('./client', () => ({ apiRequest: vi.fn() }));

describe('task API', () => {
  beforeEach(() => vi.mocked(apiRequest).mockResolvedValue({} as never));

  it('uses server-owned task creation and supports status/log pagination', async () => {
    await createTask('project-id');
    await listProjectTasks('project-id', { page: 2, pageSize: 5, status: 'FAILED' });
    await readTaskLogs('task-id', 128, 256);
    await cancelTask('task-id');
    await rebuildTask('task-id');

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/projects/project-id/tasks', {
      method: 'POST',
      body: {},
    });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      '/projects/project-id/tasks?page=2&pageSize=5&status=FAILED',
    );
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/tasks/task-id/logs?offset=128&limit=256');
    expect(apiRequest).toHaveBeenNthCalledWith(4, '/tasks/task-id/cancel', {
      method: 'POST',
      body: { reason: '用户请求停止任务' },
    });
    expect(apiRequest).toHaveBeenNthCalledWith(5, '/tasks/task-id/rebuild', {
      method: 'POST',
      body: {},
    });
  });
});
