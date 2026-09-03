import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';

import { PrismaService } from '../database/prisma.service';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

describe('HealthController', () => {
  let moduleRef: TestingModule;
  let controller: HealthController;
  let storageRoot: string;
  const originalTaskLogRoot = process.env.TASK_LOG_ROOT;
  const originalArtifactRoot = process.env.ARTIFACT_STORAGE_ROOT;
  const originalWebRoot = process.env.WEB_STATIC_ROOT;

  beforeEach(async () => {
    storageRoot = await fs.mkdtemp(join(tmpdir(), 'buildplatform-health-'));
    process.env.TASK_LOG_ROOT = join(storageRoot, 'task-logs');
    process.env.ARTIFACT_STORAGE_ROOT = join(storageRoot, 'artifacts');
    delete process.env.WEB_STATIC_ROOT;
    moduleRef = await Test.createTestingModule({ imports: [HealthModule] })
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) })
      .compile();
    controller = moduleRef.get(HealthController);
  });

  afterEach(async () => {
    await moduleRef.close();
    await fs.rm(storageRoot, { recursive: true, force: true });
    if (originalTaskLogRoot === undefined) delete process.env.TASK_LOG_ROOT;
    else process.env.TASK_LOG_ROOT = originalTaskLogRoot;
    if (originalArtifactRoot === undefined) delete process.env.ARTIFACT_STORAGE_ROOT;
    else process.env.ARTIFACT_STORAGE_ROOT = originalArtifactRoot;
    if (originalWebRoot === undefined) delete process.env.WEB_STATIC_ROOT;
    else process.env.WEB_STATIC_ROOT = originalWebRoot;
  });

  it('resolves the controller through the module', () => {
    expect(controller).toBeInstanceOf(HealthController);
  });

  it('answers the liveness probe', () => {
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
  });

  it('reports service status including the shared contracts package', () => {
    const status = controller.getHealth();

    expect(status.status).toBe('ok');
    expect(status.service).toBe('@anvilrun/server');
    expect(status.contracts.name).toBe('@anvilrun/contracts');
    expect(status.contracts.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports ready when database and storage probes succeed', async () => {
    const response = { status: jest.fn() };

    const readiness = await controller.getReadiness(response as never);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(readiness).toMatchObject({
      status: 'ok',
      database: { status: 'ok' },
      taskLogs: { status: 'ok' },
      artifacts: { status: 'ok' },
      web: { status: 'disabled' },
    });
  });

  it('reports unavailable without exposing paths when the database probe fails', async () => {
    const prisma = moduleRef.get(PrismaService) as { $queryRaw: jest.Mock };
    prisma.$queryRaw.mockRejectedValueOnce(new Error('private database details'));
    const response = { status: jest.fn() };

    const readiness = await controller.getReadiness(response as never);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(readiness.status).toBe('unavailable');
    expect(readiness.database).toEqual({ status: 'unavailable', message: 'database query failed' });
    expect(JSON.stringify(readiness)).not.toContain(storageRoot);
    expect(JSON.stringify(readiness)).not.toContain('private database details');
  });

  it('requires index.html when static hosting is configured', async () => {
    const webRoot = join(storageRoot, 'web');
    await fs.mkdir(webRoot, { recursive: true });
    process.env.WEB_STATIC_ROOT = webRoot;
    const response = { status: jest.fn() };

    const readiness = await controller.getReadiness(response as never);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(readiness.web).toEqual({ status: 'unavailable', message: 'web index unavailable' });
  });
});
