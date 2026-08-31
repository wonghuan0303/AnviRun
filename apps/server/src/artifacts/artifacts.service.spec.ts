import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileChunkFully } from './artifacts.service';

describe('writeFileChunkFully', () => {
  it('continues after short writes until the whole chunk is persisted', async () => {
    const writes: Buffer[] = [];
    const handle = {
      write: async (buffer: Buffer, offset: number, length: number) => {
        const bytesWritten = Math.min(2, length);
        writes.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)));
        return { bytesWritten };
      },
    };

    await writeFileChunkFully(handle, Buffer.from('partial-write-payload'));

    expect(Buffer.concat(writes)).toEqual(Buffer.from('partial-write-payload'));
    expect(writes.length).toBeGreaterThan(1);
  });

  it('keeps the real file complete and hashable after short writes', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'buildplatform-partial-write-'));
    const path = join(directory, 'artifact.bin');
    const content = Buffer.from('complete-partial-write-content');
    const file = await fs.open(path, 'w');
    try {
      const handle = {
        write: async (buffer: Buffer, offset: number, length: number) =>
          file.write(buffer, offset, Math.min(3, length)),
      };
      await writeFileChunkFully(handle, content);
      await file.sync();
    } finally {
      await file.close();
    }
    const stored = await fs.readFile(path);
    expect(stored).toEqual(content);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('fails safely when the underlying handle reports no progress', async () => {
    const handle = {
      write: async () => ({ bytesWritten: 0 }),
    };

    await expect(writeFileChunkFully(handle, Buffer.from('payload'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
