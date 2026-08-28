import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Injectable } from '@nestjs/common';

import { TASK_LOG_CHUNK_MAX_BYTES, type LogStream } from '@buildplatform/contracts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_TASK_LOG_CHUNK_BYTES = TASK_LOG_CHUNK_MAX_BYTES;
export const MAX_TASK_LOG_READ_BYTES = 1024 * 1024;
const MAX_TASK_LOG_FILE_BYTES = 1024 * 1024 * 1024;

export interface TaskLogEntry {
  readonly sequence: number;
  readonly stream: LogStream;
  readonly chunk: string;
  readonly emittedAt: string;
}

export interface TaskLogReadResult {
  readonly entries: TaskLogEntry[];
  readonly nextOffset: number;
  readonly size: number;
  readonly eof: boolean;
}

export interface TaskLogFileState {
  readonly size: number;
  readonly lastSequence: number;
}

export class TaskLogStorageError extends Error {
  constructor(readonly kind: 'INVALID_PATH' | 'INVALID_OFFSET' | 'INVALID_SEQUENCE' | 'IO') {
    super(kind);
    this.name = 'TaskLogStorageError';
  }
}

/** 文件型任务日志存储；日志正文不进入 PostgreSQL。 */
@Injectable()
export class TaskLogStorageService {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly states = new Map<string, TaskLogFileState>();

  constructor() {
    this.root = resolve(process.env.TASK_LOG_ROOT ?? join(process.cwd(), 'data', 'task-logs'));
    if (this.isFilesystemRoot(this.root)) throw new TaskLogStorageError('INVALID_PATH');
  }

  getRoot(): string {
    return this.root;
  }

  async getState(taskId: string, expected?: TaskLogFileState): Promise<TaskLogFileState> {
    return this.withTaskLock(taskId, async () => {
      const cached = this.states.get(taskId);
      if (
        cached &&
        (!expected ||
          (cached.size === expected.size && cached.lastSequence === expected.lastSequence))
      ) {
        const filePath = await this.filePath(taskId, false);
        try {
          const actualSize = Number((await fs.stat(filePath)).size);
          if (actualSize === cached.size) return cached;
        } catch (error) {
          if (this.isNotFound(error) && cached.size === 0) return cached;
          if (!this.isNotFound(error)) throw new TaskLogStorageError('IO');
        }
      }
      return this.recoverUnlocked(taskId);
    });
  }

  async append(taskId: string, entry: TaskLogEntry): Promise<number> {
    return this.withTaskLock(taskId, async () => {
      const filePath = await this.filePath(taskId, true);
      let state = this.states.get(taskId) ?? (await this.recoverUnlocked(taskId));
      const encoded = Buffer.from(JSON.stringify(entry) + '\n', 'utf8');
      if (encoded.byteLength > MAX_TASK_LOG_CHUNK_BYTES + 2_048) {
        throw new TaskLogStorageError('IO');
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let actualSize = 0;
        try {
          actualSize = Number((await fs.stat(filePath)).size);
        } catch (error) {
          if (!this.isNotFound(error)) throw new TaskLogStorageError('IO');
        }
        if (actualSize !== state.size) {
          state = await this.recoverUnlocked(taskId);
          continue;
        }
        if (entry.sequence !== state.lastSequence + 1) {
          throw new TaskLogStorageError('INVALID_SEQUENCE');
        }
        if (
          actualSize > MAX_TASK_LOG_FILE_BYTES ||
          actualSize + encoded.byteLength > MAX_TASK_LOG_FILE_BYTES
        ) {
          throw new TaskLogStorageError('IO');
        }
        await this.rejectSymlink(filePath, true);
        const handle = await fs.open(
          filePath,
          constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
        );
        try {
          const before = Number((await handle.stat()).size);
          if (before !== state.size) {
            state = await this.recoverUnlocked(taskId);
            continue;
          }
          let written = 0;
          while (written < encoded.byteLength) {
            const result = await handle.write(encoded, written, encoded.byteLength - written);
            if (result.bytesWritten === 0) throw new TaskLogStorageError('IO');
            written += result.bytesWritten;
          }
          await handle.sync();
          const nextState = {
            size: actualSize + encoded.byteLength,
            lastSequence: entry.sequence,
          };
          this.states.set(taskId, nextState);
          return nextState.size;
        } finally {
          await handle.close();
        }
      }
      throw new TaskLogStorageError('IO');
    });
  }

  async read(taskId: string, offset: number, limit: number): Promise<TaskLogReadResult> {
    return this.withTaskLock(taskId, async () => {
      const filePath = await this.filePath(taskId, false);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new TaskLogStorageError('INVALID_OFFSET');
      }
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TaskLogStorageError('INVALID_OFFSET');
      }
      const boundedLimit = Math.min(limit, MAX_TASK_LOG_READ_BYTES);
      let state = this.states.get(taskId) ?? (await this.recoverUnlocked(taskId));
      let size = 0;
      try {
        size = Number((await fs.stat(filePath)).size);
      } catch (error) {
        if (this.isNotFound(error)) {
          if (offset !== 0) throw new TaskLogStorageError('INVALID_OFFSET');
          return { entries: [], nextOffset: 0, size: 0, eof: true };
        }
        throw new TaskLogStorageError('IO');
      }
      if (size !== state.size) {
        state = await this.recoverUnlocked(taskId);
        size = state.size;
      }
      if (!Number.isSafeInteger(size) || offset > size) {
        throw new TaskLogStorageError('INVALID_OFFSET');
      }
      if (offset > 0 && !(await this.isRecordBoundary(filePath, offset))) {
        throw new TaskLogStorageError('INVALID_OFFSET');
      }
      if (offset === size) return { entries: [], nextOffset: offset, size, eof: true };

      const entries: TaskLogEntry[] = [];
      let nextOffset = offset;
      let consumed = 0;
      const input = createReadStream(filePath, { start: offset, encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
          if (nextOffset + lineBytes > size) break;
          if (entries.length > 0 && consumed + lineBytes > boundedLimit) break;
          if (line.length === 0) {
            nextOffset += lineBytes;
            consumed += lineBytes;
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            break;
          }
          if (!this.isEntry(parsed)) break;
          entries.push(parsed);
          nextOffset += lineBytes;
          consumed += lineBytes;
          if (consumed >= boundedLimit) break;
        }
      } finally {
        input.destroy();
      }
      return { entries, nextOffset, size, eof: nextOffset >= size };
    });
  }

  async inspect(taskId: string): Promise<TaskLogFileState> {
    return this.getState(taskId);
  }

  async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.locks.set(taskId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(taskId) === current) this.locks.delete(taskId);
    }
  }

  private async recoverUnlocked(taskId: string): Promise<TaskLogFileState> {
    const filePath = await this.filePath(taskId, false);
    let size = 0;
    try {
      size = Number((await fs.stat(filePath)).size);
    } catch (error) {
      if (this.isNotFound(error)) {
        const empty = { size: 0, lastSequence: 0 };
        this.states.set(taskId, empty);
        return empty;
      }
      throw new TaskLogStorageError('IO');
    }
    if (!Number.isSafeInteger(size)) throw new TaskLogStorageError('IO');

    const input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let validOffset = 0;
    let lastSequence = 0;
    try {
      for await (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        if (validOffset + lineBytes > size || line.length === 0) {
          break;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          break;
        }
        if (!this.isEntry(parsed) || parsed.sequence !== lastSequence + 1) {
          break;
        }
        validOffset += lineBytes;
        lastSequence = parsed.sequence;
      }
    } catch {
      throw new TaskLogStorageError('IO');
    } finally {
      input.destroy();
    }

    if (validOffset < size) {
      const handle = await fs.open(filePath, 'r+');
      try {
        await handle.truncate(validOffset);
        await handle.sync();
      } catch {
        throw new TaskLogStorageError('IO');
      } finally {
        await handle.close();
      }
    }
    const state = { size: validOffset, lastSequence };
    this.states.set(taskId, state);
    return state;
  }

  private async filePath(taskId: string, createDirectory: boolean): Promise<string> {
    if (!UUID_PATTERN.test(taskId)) throw new TaskLogStorageError('INVALID_PATH');
    await this.ensureRoot(true);
    const canonicalId = taskId.toLowerCase();
    const directory = join(this.root, canonicalId.slice(0, 2));
    if (createDirectory) await fs.mkdir(directory, { recursive: true });
    await this.rejectSymlink(directory, !createDirectory);
    const target = join(directory, canonicalId + '.ndjson');
    const rootRelative = relative(this.root, target);
    if (rootRelative.startsWith('..') || isAbsolute(rootRelative)) {
      throw new TaskLogStorageError('INVALID_PATH');
    }
    await this.rejectSymlink(target, true);
    return target;
  }

  private async ensureRoot(createDirectory: boolean): Promise<void> {
    if (createDirectory) await fs.mkdir(this.root, { recursive: true });
    await this.rejectSymlink(this.root, !createDirectory);
    const rootParent = dirname(this.root);
    if (rootParent !== this.root) await this.rejectSymlink(rootParent, true);
  }

  private async rejectSymlink(path: string, allowMissing: boolean): Promise<void> {
    try {
      const stats = await fs.lstat(path);
      if (stats.isSymbolicLink()) throw new TaskLogStorageError('INVALID_PATH');
    } catch (error) {
      if (this.isNotFound(error) && allowMissing) return;
      if (error instanceof TaskLogStorageError) throw error;
      throw new TaskLogStorageError('IO');
    }
  }

  private async isRecordBoundary(filePath: string, offset: number): Promise<boolean> {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, offset - 1);
      return buffer[0] === 0x0a;
    } finally {
      await handle.close();
    }
  }

  private isEntry(value: unknown): value is TaskLogEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    return (
      typeof entry.sequence === 'number' &&
      Number.isSafeInteger(entry.sequence) &&
      entry.sequence > 0 &&
      (entry.stream === 'stdout' || entry.stream === 'stderr') &&
      typeof entry.chunk === 'string' &&
      typeof entry.emittedAt === 'string'
    );
  }

  private isNotFound(error: unknown): boolean {
    return (
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
  }

  private isFilesystemRoot(path: string): boolean {
    return parse(path).root === path;
  }
}
