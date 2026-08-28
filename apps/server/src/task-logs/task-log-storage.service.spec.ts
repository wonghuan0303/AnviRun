import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  TaskLogStorageService,
  type TaskLogEntry,
  type TaskLogFileState,
} from './task-log-storage.service';

describe('TaskLogStorageService', () => {
  const originalRoot = process.env.TASK_LOG_ROOT;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(process.cwd(), 'task-log-storage-test-'));
    process.env.TASK_LOG_ROOT = root;
  });

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env.TASK_LOG_ROOT;
    else process.env.TASK_LOG_ROOT = originalRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  function entry(sequence: number, chunk = 'line-' + sequence): TaskLogEntry {
    return {
      sequence,
      stream: 'stdout',
      chunk,
      emittedAt: '2026-08-27T00:00:00.000Z',
    };
  }

  function pathFor(taskId: string): string {
    const id = taskId.toLowerCase();
    return join(root, id.slice(0, 2), id + '.ndjson');
  }

  it('recovers a partial or invalid tail, then accepts the next continuous record', async () => {
    const taskId = randomUUID();
    const storage = new TaskLogStorageService();
    await storage.append(taskId, entry(1));
    const path = pathFor(taskId);
    const valid = await fs.readFile(path);
    await fs.appendFile(
      path,
      JSON.stringify(entry(3, 'gap')) + '\n' + JSON.stringify(entry(4, 'partial')).slice(0, -3),
      'utf8',
    );

    const recoveredStorage = new TaskLogStorageService();
    await expect(recoveredStorage.getState(taskId)).resolves.toEqual({
      size: valid.byteLength,
      lastSequence: 1,
    });
    await expect(recoveredStorage.append(taskId, entry(2))).resolves.toBeGreaterThan(
      valid.byteLength,
    );
    await expect(recoveredStorage.read(taskId, 0, 1024)).resolves.toMatchObject({
      entries: [entry(1), entry(2)],
      eof: true,
    });
  });

  it('uses the cached synced cursor on normal appends instead of rescanning the file', async () => {
    const taskId = randomUUID();
    const storage = new TaskLogStorageService();
    const recover = jest.spyOn(
      storage as unknown as {
        recoverUnlocked(id: string): Promise<TaskLogFileState>;
      },
      'recoverUnlocked',
    );

    await storage.getState(taskId);
    await storage.append(taskId, entry(1));
    await storage.append(taskId, entry(2));
    await storage.getState(taskId);

    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('recovers a database-behind or database-ahead cursor to the exact file state', async () => {
    const taskId = randomUUID();
    const storage = new TaskLogStorageService();
    const firstOffset = await storage.append(taskId, entry(1));
    const secondOffset = await storage.append(taskId, entry(2));

    await expect(storage.getState(taskId, { size: 0, lastSequence: 0 })).resolves.toEqual({
      size: secondOffset,
      lastSequence: 2,
    });
    await expect(
      storage.getState(taskId, { size: secondOffset, lastSequence: 8 }),
    ).resolves.toEqual({ size: secondOffset, lastSequence: 2 });
    expect(firstOffset).toBeLessThan(secondOffset);
  });
});
