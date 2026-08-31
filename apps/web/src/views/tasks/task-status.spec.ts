import { describe, expect, it } from 'vitest';

import { TASK_STATUSES, taskOperationLabel, taskStatusLabel } from './task-status';

describe('task status presentation', () => {
  it('provides a Chinese label for every server task status', () => {
    expect(TASK_STATUSES).toHaveLength(12);
    for (const status of TASK_STATUSES) expect(taskStatusLabel(status)).not.toBe(status);
  });

  it('uses cancel, stop and rebuild-safe terminal operation semantics', () => {
    expect(taskOperationLabel('QUEUED')).toBe('取消任务');
    expect(taskOperationLabel('RUNNING')).toBe('停止任务');
    expect(taskOperationLabel('CANCELING')).toBe('正在停止');
    expect(taskOperationLabel('SUCCEEDED')).toBeNull();
  });
});
