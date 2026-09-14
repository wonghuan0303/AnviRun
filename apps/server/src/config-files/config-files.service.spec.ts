import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import type { PrismaService } from '../database/prisma.service';
import { ConfigFilesService } from './config-files.service';

describe('ConfigFilesService', () => {
  let root: string;
  let service: ConfigFilesService;
  let created: Record<string, unknown> | undefined;
  const actor = { id: '00000000-0000-4000-8000-000000000001' } as AuthenticatedRequestUser;
  const templateId = '00000000-0000-4000-8000-000000000002';

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'config-files-'));
    process.env.CONFIG_FILE_STORAGE_ROOT = root;
    created = undefined;
    const prisma = {
      buildTemplate: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          formSchema: [
            {
              type: 'file',
              name: 'packageFile',
              label: '安装包',
              required: true,
              allowedExtensions: ['.zip'],
              fileNamePattern: 'app-[0-9]+\\.zip',
              maxSizeBytes: 32,
            },
          ],
        }),
      },
      configFile: {
        create: jest.fn().mockImplementation(({ data }) => {
          created = data;
          return data;
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaService;
    service = new ConfigFilesService(prisma);
  });

  afterEach(async () => {
    service.onModuleDestroy();
    delete process.env.CONFIG_FILE_STORAGE_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('streams a valid file, computes its hash, and returns an immutable reference', async () => {
    async function* body() {
      yield Buffer.from('zip-content');
    }
    const result = await service.upload(
      actor,
      templateId,
      'packageFile',
      'app-1.zip',
      'application/zip',
      '11',
      body(),
    );
    expect(result.file.fileName).toBe('app-1.zip');
    expect(result.file.size).toBe(11);
    expect(result.file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await fs.readFile(String(created?.storagePath), 'utf8')).toBe('zip-content');
  });

  it('rejects an invalid package name before reading the body', async () => {
    let read = false;
    async function* body() {
      read = true;
      yield Buffer.from('x');
    }
    await expect(
      service.upload(actor, templateId, 'packageFile', 'other.zip', 'application/zip', '1', body()),
    ).rejects.toBeInstanceOf(ApiException);
    expect(read).toBe(false);
  });

  it('binds selected files and detaches replaced project files for later cleanup', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const transaction = { configFile: { updateMany } };

    await service.reconcileProjectFiles(
      transaction as never,
      actor.id,
      '00000000-0000-4000-8000-000000000003',
      ['00000000-0000-4000-8000-000000000004'],
    );

    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          projectId: '00000000-0000-4000-8000-000000000003',
          id: { notIn: ['00000000-0000-4000-8000-000000000004'] },
        },
        data: expect.objectContaining({ projectId: null, detachedAt: expect.any(Date) }),
      }),
    );
  });
});
