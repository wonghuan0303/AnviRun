import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { AgentStatus, BuildTaskStatus, UserRole, UserStatus } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import request, { type Response } from 'supertest';
import type { TaskArtifactManifestMessage } from '@anvilrun/contracts';

import { AppModule } from '../../src/app.module';
import { ArtifactsService } from '../../src/artifacts/artifacts.service';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PasswordService } from '../../src/auth/password.service';
import { PrismaService } from '../../src/database/prisma.service';
import { TaskLeaseService } from '../../src/tasks/task-lease.service';
import type { AuthenticatedRequestUser } from '../../src/auth/auth.types';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Artifact integration tests require buildplatform_test');
}

jest.setTimeout(30_000);

function binaryParser(
  response: Response,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', (error: Error) => callback(error));
}

function parseStoredZip(body: Buffer): Map<string, Buffer> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = body.lastIndexOf(endSignature);
  if (endOffset < 0) throw new Error('ZIP end record is missing');
  const count = body.readUInt16LE(endOffset + 10);
  let cursor = body.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (body.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP central record is invalid');
    const compressedSize = body.readUInt32LE(cursor + 20);
    const nameLength = body.readUInt16LE(cursor + 28);
    const extraLength = body.readUInt16LE(cursor + 30);
    const commentLength = body.readUInt16LE(cursor + 32);
    const localOffset = body.readUInt32LE(cursor + 42);
    const name = body.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (body.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error('ZIP local record is invalid');
    const localNameLength = body.readUInt16LE(localOffset + 26);
    const localExtraLength = body.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, Buffer.from(body.subarray(dataStart, dataStart + compressedSize)));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('T5.3 artifact PostgreSQL/API integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let artifacts: ArtifactsService;
  let leases: TaskLeaseService;
  let storageRoot: string;
  let adminToken: string;
  let ownerToken: string;
  let otherToken: string;
  let ownerId: string;
  let agentId: string;
  let templateId: string;
  let projectId: string;

  async function resetDatabase(): Promise<void> {
    await prisma.agent.updateMany({ data: { activeTaskId: null } });
    await prisma.artifact.deleteMany();
    await prisma.buildTaskStatusHistory.deleteMany();
    await prisma.buildTask.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.project.deleteMany();
    await prisma.buildTemplate.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  }

  async function login(username: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username, password });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  async function createUploadingTask(): Promise<{ id: string; leaseToken: string }> {
    const lease = leases.generate(60);
    const task = await prisma.buildTask.create({
      data: {
        projectId,
        buildTemplateId: templateId,
        agentId,
        createdBy: ownerId,
        status: BuildTaskStatus.UPLOADING,
        assignedArtifactDir: 'dist',
        branch: 'main',
        config: {},
        startedAt: new Date(),
        leaseHash: lease.hash,
        leaseExpiresAt: lease.expiresAt,
      },
    });
    await prisma.agent.update({ where: { id: agentId }, data: { activeTaskId: task.id } });
    return { id: task.id, leaseToken: lease.token };
  }

  function manifestFiles(
    taskId: string,
    leaseToken: string,
    files: readonly { relativePath: string; content: Buffer }[],
  ) {
    return {
      id: 'manifest-' + taskId,
      type: 'task.artifact-manifest' as const,
      timestamp: new Date().toISOString(),
      protocolVersion: 1 as const,
      payload: {
        taskId,
        leaseToken,
        artifactDir: 'dist',
        totalBytes: files.reduce((sum, file) => sum + file.content.length, 0),
        files: files.map((file) => ({
          relativePath: file.relativePath,
          size: file.content.length,
          sha256: createHash('sha256').update(file.content).digest('hex'),
        })),
      },
    };
  }

  function manifest(taskId: string, leaseToken: string, content: Buffer) {
    return manifestFiles(taskId, leaseToken, [{ relativePath: 'nested/app.txt', content }]);
  }

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(join(process.cwd(), 'tmp-artifacts-'));
    process.env.ARTIFACT_STORAGE_ROOT = storageRoot;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    artifacts = app.get(ArtifactsService);
    leases = app.get(TaskLeaseService);
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    const adminPassword = 'artifact-admin-password';
    const ownerPassword = 'artifact-owner-password';
    const otherPassword = 'artifact-other-password';
    const [admin, owner, other] = await Promise.all([
      prisma.user.create({
        data: {
          username: 'artifact-admin',
          passwordHash: await passwords.hash(adminPassword),
          role: UserRole.ADMIN,
        },
      }),
      prisma.user.create({
        data: { username: 'artifact-owner', passwordHash: await passwords.hash(ownerPassword) },
      }),
      prisma.user.create({
        data: { username: 'artifact-other', passwordHash: await passwords.hash(otherPassword) },
      }),
    ]);
    const agent = await prisma.agent.create({
      data: { name: 'artifact-agent', enabled: true, status: AgentStatus.ONLINE },
    });
    const template = await prisma.buildTemplate.create({
      data: {
        name: 'artifact-template',
        agentId: agent.id,
        createdBy: admin.id,
        gitUrl: 'https://example.invalid/artifacts.git',
        command: 'build',
        artifactDir: 'dist',
        formSchema: [],
      },
    });
    const project = await prisma.project.create({
      data: {
        ownerId: owner.id,
        buildTemplateId: template.id,
        name: 'Artifact project',
        branch: 'main',
        config: {},
      },
    });
    ownerId = owner.id;
    agentId = agent.id;
    templateId = template.id;
    projectId = project.id;
    app.get(LoginRateLimiterService).reset();
    adminToken = await login(admin.username, adminPassword);
    ownerToken = await login(owner.username, ownerPassword);
    otherToken = await login(other.username, otherPassword);
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(storageRoot, { recursive: true, force: true });
    delete process.env.ARTIFACT_STORAGE_ROOT;
  });

  it('registers, streams, completes, lists, downloads, archives, and soft deletes artifacts', async () => {
    const files = [
      { relativePath: 'nested/app.txt', content: Buffer.from('artifact-content\n', 'utf8') },
      { relativePath: 'other/app.txt', content: Buffer.from('same-name-different-path', 'utf8') },
      { relativePath: '发布/结果.txt', content: Buffer.from('unicode artifact', 'utf8') },
    ];
    const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
    const task = await createUploadingTask();
    await expect(
      artifacts.registerManifest('' + agentId, manifestFiles(task.id, task.leaseToken, files)),
    ).resolves.toMatchObject({
      payload: { accepted: true, artifactCount: files.length, artifactBytes: totalBytes },
    });

    for (const file of files) {
      const uploaded = await request(app.getHttpServer())
        .put(`/api/agent/tasks/${task.id}/artifacts/content`)
        .query({ relativePath: file.relativePath })
        .set('Authorization', `Bearer ${task.leaseToken}`)
        .set('Content-Type', 'application/octet-stream')
        .send(file.content);
      expect(uploaded.status).toBe(200);
      expect(uploaded.body.artifact.relativePath).toBe(file.relativePath);
      expect(uploaded.body.artifact.storagePath).toBeUndefined();
      expect(uploaded.body.artifact.leaseToken).toBeUndefined();
    }

    const replay = await request(app.getHttpServer())
      .put(`/api/agent/tasks/${task.id}/artifacts/content`)
      .query({ relativePath: 'nested/app.txt' })
      .set('Authorization', `Bearer ${task.leaseToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(files[0].content);
    expect(replay.status).toBe(200);

    await expect(
      artifacts.completeTask('' + agentId, {
        id: 'complete-' + task.id,
        type: 'task.completed',
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        payload: {
          taskId: task.id,
          leaseToken: task.leaseToken,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
          artifactCount: files.length,
          artifactBytes: totalBytes,
        },
      }),
    ).resolves.toEqual({ taskId: task.id, completed: true });

    const stored = await prisma.artifact.findFirstOrThrow({ where: { taskId: task.id } });
    expect(stored.uploadedAt).not.toBeNull();
    expect(stored.storagePath).not.toContain(task.leaseToken);
    for (const file of files)
      expect(
        await fs.readFile(join(storageRoot, task.id, ...file.relativePath.split('/'))),
      ).toEqual(file.content);
    expect((await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      BuildTaskStatus.SUCCEEDED,
    );

    const list = await request(app.getHttpServer())
      .get(`/api/tasks/${task.id}/artifacts`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(files.length);
    const artifactId = list.body.items.find(
      (item: { relativePath: string }) => item.relativePath === 'nested/app.txt',
    ).id as string;
    const serialized = JSON.stringify(list.body);
    expect(serialized).not.toMatch(/storagePath|leaseHash|tokenHash|passwordHash|tokenVersion/);

    const adminList = await request(app.getHttpServer())
      .get(`/api/tasks/${task.id}/artifacts`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.items).toHaveLength(files.length);

    const download = await request(app.getHttpServer())
      .get(`/api/artifacts/${artifactId}/download`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .buffer(true);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.body).toEqual(files[0].content);

    const archive = await request(app.getHttpServer())
      .get(`/api/tasks/${task.id}/artifacts/archive`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .parse(binaryParser)
      .buffer(true);
    expect(archive.status).toBe(200);
    expect(archive.headers['content-type']).toContain('application/zip');
    const archiveEntries = parseStoredZip(archive.body as Buffer);
    expect([...archiveEntries.keys()].sort()).toEqual(
      files.map((file) => file.relativePath).sort(),
    );
    for (const file of files) expect(archiveEntries.get(file.relativePath)).toEqual(file.content);

    const otherList = await request(app.getHttpServer())
      .get(`/api/tasks/${task.id}/artifacts`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(otherList.status).toBe(404);
    expect(otherList.body.code).toBe('RESOURCE_NOT_FOUND');

    const deleteRequestId = 'artifact-delete-audit-001';
    const deleted = await request(app.getHttpServer())
      .delete(`/api/artifacts/${artifactId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-request-id', deleteRequestId);
    expect(deleted.status).toBe(204);
    expect(
      (await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } })).deletedAt,
    ).not.toBeNull();
    const deleteAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ARTIFACT_DELETED', resourceId: artifactId },
    });
    expect(deleteAudit.actorId).toBe(ownerId);
    expect(deleteAudit.resourceType).toBe('Artifact');
    expect(deleteAudit.requestId).toBe(deleteRequestId);
    expect(deleteAudit.metadata).toEqual({ result: 'SUCCESS', taskId: task.id });
    expect(JSON.stringify(deleteAudit.metadata)).not.toMatch(
      /password|token|authorization|cookie|csrf|config|storagePath/i,
    );
    const afterDelete = await request(app.getHttpServer())
      .get(`/api/tasks/${task.id}/artifacts`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.items).toHaveLength(files.length - 1);
  });

  it('rejects incomplete completion, unsafe paths, and cross-user artifact access', async () => {
    const content = Buffer.from('small artifact', 'utf8');
    const task = await createUploadingTask();
    await artifacts.registerManifest(agentId, manifest(task.id, task.leaseToken, content));

    const unsafe = await request(app.getHttpServer())
      .put(`/api/agent/tasks/${task.id}/artifacts/content`)
      .query({ relativePath: '../escape.txt' })
      .set('Authorization', `Bearer ${task.leaseToken}`)
      .send(content);
    expect(unsafe.status).toBe(400);
    expect(unsafe.body.code).toBe('ARTIFACT_INVALID_PATH');

    const incomplete = await request(app.getHttpServer())
      .get(`/api/artifacts/${randomUUID()}/download`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(incomplete.status).toBe(404);
    expect(incomplete.body.code).toBe('RESOURCE_NOT_FOUND');

    const before = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    const historyBefore = await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } });
    await expect(
      artifacts.completeTask(agentId, {
        id: 'complete-incomplete-' + task.id,
        type: 'task.completed',
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        payload: {
          taskId: task.id,
          leaseToken: task.leaseToken,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
          artifactCount: 1,
          artifactBytes: content.length,
        },
      }),
    ).rejects.toMatchObject({ code: 'TASK_INVALID_STATE' });
    const after = await prisma.buildTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe(BuildTaskStatus.UPLOADING);
    expect(after.leaseHash).toBe(before.leaseHash);
    expect(after.leaseExpiresAt).toEqual(before.leaseExpiresAt);
    expect(after.artifactCount).toBe(before.artifactCount);
    expect(after.artifactBytes).toBe(before.artifactBytes);
    expect(await prisma.buildTaskStatusHistory.count({ where: { taskId: task.id } })).toBe(
      historyBefore,
    );
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).activeTaskId).toBe(
      task.id,
    );
  });

  it('recovers a renamed file when uploadedAt was not persisted', async () => {
    const content = Buffer.from('recovery artifact', 'utf8');
    const task = await createUploadingTask();
    await artifacts.registerManifest(agentId, manifest(task.id, task.leaseToken, content));
    const finalPath = join(storageRoot, task.id, 'nested', 'app.txt');
    await fs.mkdir(join(storageRoot, task.id, 'nested'), { recursive: true });
    await fs.writeFile(finalPath, content);

    const recovered = await request(app.getHttpServer())
      .put(`/api/agent/tasks/${task.id}/artifacts/content`)
      .query({ relativePath: 'nested/app.txt' })
      .set('Authorization', `Bearer ${task.leaseToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);
    expect(recovered.status).toBe(200);
    expect(
      (await prisma.artifact.findFirstOrThrow({ where: { taskId: task.id } })).uploadedAt,
    ).not.toBeNull();
    await expect(
      artifacts.completeTask(agentId, {
        id: 'complete-recovery-' + task.id,
        type: 'task.completed',
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        payload: {
          taskId: task.id,
          leaseToken: task.leaseToken,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
          artifactCount: 1,
          artifactBytes: content.length,
        },
      }),
    ).resolves.toEqual({ taskId: task.id, completed: true });
  });

  it('returns a stable not-found error when a download source disappears', async () => {
    const content = Buffer.from('source disappears', 'utf8');
    const task = await prisma.buildTask.create({
      data: {
        projectId,
        buildTemplateId: templateId,
        agentId,
        createdBy: ownerId,
        status: BuildTaskStatus.SUCCEEDED,
        branch: 'main',
        config: {},
        artifactCount: 1,
        artifactBytes: content.length,
        finishedAt: new Date(),
      },
    });
    const artifact = await prisma.artifact.create({
      data: {
        taskId: task.id,
        relativePath: 'nested/missing.txt',
        fileName: 'missing.txt',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        storagePath: task.id + '/nested/missing.txt',
        uploadedAt: new Date(),
      },
    });
    const storedPath = join(storageRoot, task.id, 'nested', 'missing.txt');
    await fs.mkdir(join(storageRoot, task.id, 'nested'), { recursive: true });
    await fs.writeFile(storedPath, content);
    await fs.rm(storedPath);

    const response = await request(app.getHttpServer())
      .get(`/api/artifacts/${artifact.id}/download`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toMatch(/ENOENT|stack|storagePath/);
  });

  it('stops the source pipeline when a download client disconnects', async () => {
    const content = Buffer.alloc(512 * 1024, 0x61);
    const task = await prisma.buildTask.create({
      data: {
        projectId,
        buildTemplateId: templateId,
        agentId,
        createdBy: ownerId,
        status: BuildTaskStatus.SUCCEEDED,
        branch: 'main',
        config: {},
        artifactCount: 1,
        artifactBytes: content.length,
        finishedAt: new Date(),
      },
    });
    const artifact = await prisma.artifact.create({
      data: {
        taskId: task.id,
        relativePath: 'nested/large.txt',
        fileName: 'large.txt',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        storagePath: task.id + '/nested/large.txt',
        uploadedAt: new Date(),
      },
    });
    const storedPath = join(storageRoot, task.id, 'nested', 'large.txt');
    await fs.mkdir(join(storageRoot, task.id, 'nested'), { recursive: true });
    await fs.writeFile(storedPath, content);

    const response = new PassThrough();
    response.on('error', () => undefined);
    response.on('data', () => response.destroy(new Error('client disconnected')));
    Object.assign(response, { setHeader: () => response });
    const actor: AuthenticatedRequestUser = {
      id: ownerId,
      username: 'artifact-owner',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      tokenVersion: 0,
      jti: randomUUID(),
    };

    await expect(
      artifacts.download(actor, artifact.id, response as unknown as ExpressResponse),
    ).resolves.toBeUndefined();
    expect(response.destroyed).toBe(true);
  });

  it('enforces the ZIP-compatible manifest file limit', async () => {
    const task = await createUploadingTask();
    const files = Array.from({ length: 65_536 }, (_, index) => ({
      relativePath: `file-${index}.txt`,
      size: 0,
      sha256: '0'.repeat(64),
    }));
    const message: TaskArtifactManifestMessage = {
      id: 'manifest-too-many-' + task.id,
      type: 'task.artifact-manifest',
      timestamp: new Date().toISOString(),
      protocolVersion: 1,
      payload: {
        taskId: task.id,
        leaseToken: task.leaseToken,
        artifactDir: 'dist',
        totalBytes: 0,
        files,
      },
    };
    await expect(artifacts.registerManifest(agentId, message)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects case-colliding manifest paths on Windows', async () => {
    if (process.platform !== 'win32') return;
    const task = await createUploadingTask();
    await expect(
      artifacts.registerManifest(
        agentId,
        manifestFiles(task.id, task.leaseToken, [
          { relativePath: 'same.txt', content: Buffer.from('a') },
          { relativePath: 'SAME.txt', content: Buffer.from('b') },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
