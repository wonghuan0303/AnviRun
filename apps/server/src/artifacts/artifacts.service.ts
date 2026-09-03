import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { createReadStream, promises as fs } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { AgentStatus, BuildTaskStatus, Prisma } from '@prisma/client';
import type { Response } from 'express';
import type {
  ArtifactManifestEntry,
  TaskArtifactManifestAckMessage,
  TaskArtifactManifestMessage,
  TaskCompletedMessage,
} from '@anvilrun/contracts';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { AuthorizationService } from '../authorization/authorization.service';
import { ApiException } from '../common/api-exception';
import { AuditService } from '../common/audit.service';
import { lockAgentExecutionSlot } from '../database/execution-slot';
import { PrismaService } from '../database/prisma.service';
import { TaskLeaseService } from '../tasks/task-lease.service';
import { TaskStateService } from '../tasks/task-state.service';

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ARTIFACT_FILES = 65_535;
export const MAX_ARTIFACT_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STORAGE_CHUNK_BYTES = 64 * 1024;
const ARTIFACT_SELECT = {
  id: true,
  taskId: true,
  relativePath: true,
  fileName: true,
  size: true,
  sha256: true,
  createdAt: true,
} as const;
type ArtifactView = Prisma.ArtifactGetPayload<{ select: typeof ARTIFACT_SELECT }>;

export interface ArtifactResponse {
  readonly id: string;
  readonly taskId: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly size: string;
  readonly sha256: string;
  readonly createdAt: Date;
}
interface ValidManifest {
  readonly artifactDir: string;
  readonly totalBytes: number;
  readonly files: readonly ArtifactManifestEntry[];
}
interface ManifestResult {
  readonly taskId: string;
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly accepted: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeNumber(value: bigint | number): number {
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(result) || result < 0) throw new ApiException('VALIDATION_FAILED');
  return result;
}
function artifactResponse(artifact: ArtifactView): ArtifactResponse {
  return {
    id: artifact.id,
    taskId: artifact.taskId,
    relativePath: artifact.relativePath,
    fileName: artifact.fileName,
    size: artifact.size.toString(),
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
  };
}
function invalidPath(): ApiException {
  return new ApiException('ARTIFACT_INVALID_PATH');
}

export async function writeFileChunkFully(
  handle: {
    write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>;
  },
  chunk: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset);
    if (result.bytesWritten <= 0) throw new ApiException('VALIDATION_FAILED');
    offset += result.bytesWritten;
  }
}

function validateRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) throw invalidPath();
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw invalidPath();
  const parts = value.split('/');
  if (
    parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes(':'))
  ) {
    throw invalidPath();
  }
  if (isAbsolute(value)) throw invalidPath();
  const fileName = parts[parts.length - 1] ?? '';
  if (Array.from(fileName).length === 0 || Array.from(fileName).length > 512) throw invalidPath();
  return value;
}

function validateManifest(input: unknown): ValidManifest {
  if (!isPlainRecord(input)) throw new ApiException('VALIDATION_FAILED');
  const artifactDir = input.artifactDir;
  const totalBytes = input.totalBytes;
  const files = input.files;
  if (
    typeof artifactDir !== 'string' ||
    artifactDir.length === 0 ||
    artifactDir.length > 1_024 ||
    Array.from(artifactDir).some((character) => character.charCodeAt(0) < 32) ||
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > MAX_ARTIFACT_FILES ||
    typeof totalBytes !== 'number' ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    totalBytes > MAX_ARTIFACT_BYTES
  )
    throw new ApiException('VALIDATION_FAILED');
  const seen = new Set<string>();
  let sum = 0;
  const normalized: ArtifactManifestEntry[] = [];
  for (const item of files) {
    if (!isPlainRecord(item)) throw invalidPath();
    const relativePath = validateRelativePath(item.relativePath);
    const size = item.size;
    const sha256 = item.sha256;
    const identityPath =
      process.platform === 'win32' ? relativePath.toLocaleLowerCase('en-US') : relativePath;
    if (
      seen.has(identityPath) ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof sha256 !== 'string' ||
      !SHA256_PATTERN.test(sha256)
    )
      throw new ApiException('VALIDATION_FAILED');
    seen.add(identityPath);
    sum += size;
    if (!Number.isSafeInteger(sum) || sum > MAX_ARTIFACT_BYTES)
      throw new ApiException('ARTIFACT_SIZE_LIMIT_EXCEEDED');
    normalized.push({ relativePath, size, sha256 });
  }
  if (sum !== totalBytes) throw new ApiException('VALIDATION_FAILED');
  normalized.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { artifactDir, totalBytes, files: normalized };
}
function manifestMatches(
  existing: readonly { relativePath: string; size: bigint; sha256: string }[],
  manifest: ValidManifest,
): boolean {
  if (existing.length !== manifest.files.length) return false;
  return existing
    .map((item) => ({
      relativePath: item.relativePath,
      size: safeNumber(item.size),
      sha256: item.sha256,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .every((item, index) => {
      const expected = manifest.files[index];
      return (
        expected !== undefined &&
        item.relativePath === expected.relativePath &&
        item.size === expected.size &&
        item.sha256 === expected.sha256
      );
    });
}
function parsePage(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value))
    throw new ApiException('VALIDATION_FAILED');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new ApiException('VALIDATION_FAILED');
  return parsed;
}
function crc32Update(crc: number, chunk: Buffer): number {
  let value = crc ^ 0xffffffff;
  for (const byte of chunk) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function u16(value: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(value, 0);
  return b;
}
function u32(value: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}
function zipLocalHeader(name: Buffer): Buffer {
  return Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0x808),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(name.length),
    u16(0),
    name,
  ]);
}
function zipCentralHeader(name: Buffer, crc: number, size: number, offset: number): Buffer {
  return Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0x808),
    u16(0),
    u16(0),
    u16(0),
    u32(crc),
    u32(size),
    u32(size),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(offset),
    name,
  ]);
}
function zipEnd(count: number, directorySize: number, directoryOffset: number): Buffer {
  return Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(count),
    u16(count),
    u32(directorySize),
    u32(directoryOffset),
    u16(0),
  ]);
}
async function* zipEntries(
  entries: readonly { name: string; path: string }[],
): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const headerOffset = offset;
    const header = zipLocalHeader(name);
    yield header;
    offset += header.length;
    let crc = 0;
    let size = 0;
    const input = createReadStream(entry.path, { highWaterMark: STORAGE_CHUNK_BYTES });
    try {
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = crc32Update(crc, buffer);
        size += buffer.length;
        yield buffer;
        offset += buffer.length;
      }
    } finally {
      input.destroy();
    }
    const descriptor = Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
    yield descriptor;
    offset += descriptor.length;
    central.push(zipCentralHeader(name, crc, size, headerOffset));
  }
  const directoryOffset = offset;
  const directory = Buffer.concat(central);
  yield directory;
  yield zipEnd(entries.length, directory.length, directoryOffset);
}

@Injectable()
export class ArtifactsService {
  private readonly root: string;
  private readonly uploadLocks = new Map<string, Promise<void>>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly leases: TaskLeaseService,
    private readonly state: TaskStateService,
    private readonly audit: AuditService,
  ) {
    this.root = resolve(
      process.env.ARTIFACT_STORAGE_ROOT ?? join(process.cwd(), 'data', 'artifacts'),
    );
    if (parse(this.root).root === this.root)
      throw new Error('ARTIFACT_STORAGE_ROOT must not be a filesystem root');
  }
  getRoot(): string {
    return this.root;
  }

  async registerManifest(
    agentId: string,
    message: TaskArtifactManifestMessage,
  ): Promise<TaskArtifactManifestAckMessage> {
    if (!UUID_PATTERN.test(message.payload.taskId)) throw new ApiException('TASK_LEASE_INVALID');
    const manifest = validateManifest(message.payload);
    const result = await this.prisma.$transaction(async (tx) => {
      const agent = await lockAgentExecutionSlot(tx, agentId);
      if (!agent || !agent.enabled || agent.status !== AgentStatus.ONLINE)
        throw new ApiException('TASK_LEASE_INVALID');
      const task = await tx.buildTask.findUnique({
        where: { id: message.payload.taskId },
        select: {
          id: true,
          agentId: true,
          status: true,
          leaseHash: true,
          leaseExpiresAt: true,
          assignedArtifactDir: true,
        },
      });
      this.assertLease(task, agentId, agent.activeTaskId, message.payload.leaseToken, true);
      if (task.assignedArtifactDir === null || task.assignedArtifactDir !== manifest.artifactDir)
        throw new ApiException('VALIDATION_FAILED');
      const existing = await tx.artifact.findMany({
        where: { taskId: task.id },
        select: { relativePath: true, size: true, sha256: true },
      });
      if (existing.length > 0) {
        if (!manifestMatches(existing, manifest)) throw new ApiException('TASK_INVALID_STATE');
        return {
          taskId: task.id,
          accepted: true as const,
          artifactCount: existing.length,
          artifactBytes: existing.reduce((sum, item) => sum + safeNumber(item.size), 0),
        };
      }
      await this.prepareTaskDirectory(task.id, manifest.files);
      await tx.artifact.createMany({
        data: manifest.files.map((file) => ({
          taskId: task.id,
          relativePath: file.relativePath,
          fileName: file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1),
          size: BigInt(file.size),
          sha256: file.sha256,
          storagePath: task.id + '/' + file.relativePath,
        })),
      });
      return {
        taskId: task.id,
        accepted: true as const,
        artifactCount: manifest.files.length,
        artifactBytes: manifest.totalBytes,
      };
    });
    return this.manifestAck(result);
  }

  manifestRejectedAck(taskId: string): TaskArtifactManifestAckMessage {
    return this.manifestAck({
      taskId,
      accepted: false,
      artifactCount: 0,
      artifactBytes: 0,
    });
  }

  async uploadFromAgent(
    taskId: string,
    leaseToken: string,
    relativePath: string,
    request: AsyncIterable<Buffer | string>,
  ): Promise<{ artifact: ArtifactResponse }> {
    if (!UUID_PATTERN.test(taskId)) throw new ApiException('TASK_LEASE_INVALID');
    const normalizedPath = validateRelativePath(relativePath);
    return this.withUploadLock(taskId + ':' + normalizedPath, async () => {
      const artifact = await this.prisma.artifact.findFirst({
        where: { taskId, relativePath: normalizedPath },
        select: {
          ...ARTIFACT_SELECT,
          deletedAt: true,
          uploadedAt: true,
          task: {
            select: {
              id: true,
              agentId: true,
              status: true,
              leaseHash: true,
              leaseExpiresAt: true,
              agent: { select: { activeTaskId: true, enabled: true, status: true } },
            },
          },
        },
      });
      if (!artifact || artifact.deletedAt !== null) throw new ApiException('RESOURCE_NOT_FOUND');
      if (!artifact.task.agent.enabled || artifact.task.agent.status !== AgentStatus.ONLINE)
        throw new ApiException('TASK_LEASE_INVALID');
      this.assertLease(
        artifact.task,
        artifact.task.agentId,
        artifact.task.agent.activeTaskId,
        leaseToken,
        true,
      );
      const finalPath = await this.safeStoredPath(taskId, normalizedPath, true);
      if (artifact.uploadedAt !== null) {
        const actual = await this.hashFile(finalPath).catch(() => undefined);
        if (!actual) throw new ApiException('RESOURCE_NOT_FOUND');
        if (actual.size !== safeNumber(artifact.size) || actual.sha256 !== artifact.sha256)
          throw new ApiException('VALIDATION_FAILED');
        return { artifact: artifactResponse(artifact) };
      }
      const existingFinal = await fs.lstat(finalPath).catch((error: unknown) => {
        if (this.isNotFound(error)) return undefined;
        throw error;
      });
      if (existingFinal) {
        if (!existingFinal.isFile()) throw invalidPath();
        const actual = await this.hashFile(finalPath).catch(() => undefined);
        if (
          !actual ||
          actual.size !== safeNumber(artifact.size) ||
          actual.sha256 !== artifact.sha256
        )
          throw new ApiException('VALIDATION_FAILED');
        await this.prisma.artifact.updateMany({
          where: { id: artifact.id, uploadedAt: null },
          data: { uploadedAt: new Date() },
        });
        const restored = await this.prisma.artifact.findUnique({
          where: { id: artifact.id },
          select: { ...ARTIFACT_SELECT, uploadedAt: true },
        });
        if (!restored || restored.uploadedAt === null) throw new ApiException('TASK_INVALID_STATE');
        return { artifact: artifactResponse(restored) };
      }
      const temporary =
        finalPath +
        '.tmp-' +
        process.pid +
        '-' +
        Date.now() +
        '-' +
        Math.random().toString(16).slice(2);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      let moved = false;
      try {
        handle = await fs.open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        const hash = createHash('sha256');
        let size = 0;
        for await (const raw of request) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          size += chunk.length;
          if (size > safeNumber(artifact.size) || size > MAX_ARTIFACT_BYTES)
            throw new ApiException('ARTIFACT_SIZE_LIMIT_EXCEEDED');
          hash.update(chunk);
          await writeFileChunkFully(handle, chunk);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        if (size !== safeNumber(artifact.size) || hash.digest('hex') !== artifact.sha256)
          throw new ApiException('VALIDATION_FAILED');
        const temporaryStats = await fs.stat(temporary);
        if (temporaryStats.size !== safeNumber(artifact.size))
          throw new ApiException('VALIDATION_FAILED');
        try {
          await fs.stat(finalPath);
          throw new ApiException('VALIDATION_FAILED');
        } catch (error) {
          if (error instanceof ApiException) throw error;
          if (!this.isNotFound(error)) throw new ApiException('RESOURCE_NOT_FOUND');
        }
        await fs.rename(temporary, finalPath);
        moved = true;
        const updated = await this.prisma.artifact.update({
          where: { id: artifact.id },
          data: { uploadedAt: new Date() },
          select: ARTIFACT_SELECT,
        });
        return { artifact: artifactResponse(updated) };
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        if (moved) {
          await fs.rm(finalPath, { force: true }).catch(() => undefined);
        }
        if (error instanceof ApiException) throw error;
        throw new ApiException('VALIDATION_FAILED');
      }
    });
  }

  async completeTask(
    agentId: string,
    message: TaskCompletedMessage,
  ): Promise<{ taskId: string; completed: true }> {
    const payload = message.payload;
    if (!UUID_PATTERN.test(payload.taskId) || payload.exitCode !== 0)
      throw new ApiException('VALIDATION_FAILED');
    return this.prisma.$transaction(async (tx) => {
      const agent = await lockAgentExecutionSlot(tx, agentId);
      if (!agent) throw new ApiException('TASK_LEASE_INVALID');
      if (!agent.enabled || agent.status !== AgentStatus.ONLINE)
        throw new ApiException('TASK_LEASE_INVALID');
      const task = await tx.buildTask.findUnique({
        where: { id: payload.taskId },
        select: {
          id: true,
          agentId: true,
          status: true,
          leaseHash: true,
          leaseExpiresAt: true,
          sourceCommit: true,
          artifactCount: true,
          artifactBytes: true,
          logLeaseHash: true,
          logLeaseExpiresAt: true,
        },
      });
      if (!task || task.agentId !== agentId) throw new ApiException('TASK_LEASE_INVALID');
      if (task.status === BuildTaskStatus.SUCCEEDED) {
        if (
          !task.logLeaseHash ||
          !task.logLeaseExpiresAt ||
          task.logLeaseExpiresAt.getTime() <= Date.now() ||
          !this.leases.verify(payload.leaseToken, task.logLeaseHash)
        )
          throw new ApiException('TASK_LEASE_INVALID');
        if (
          safeNumber(task.artifactCount) !== payload.artifactCount ||
          safeNumber(task.artifactBytes) !== payload.artifactBytes
        )
          throw new ApiException('TASK_INVALID_STATE');
        return { taskId: task.id, completed: true as const };
      }
      this.assertLease(task, agentId, agent.activeTaskId, payload.leaseToken, true);
      const files = await tx.artifact.findMany({
        where: { taskId: task.id },
        select: { uploadedAt: true, size: true },
      });
      const bytes = files.reduce((sum, file) => sum + safeNumber(file.size), 0);
      if (
        files.length === 0 ||
        files.some((file) => file.uploadedAt === null) ||
        files.length !== payload.artifactCount ||
        bytes !== payload.artifactBytes
      )
        throw new ApiException('TASK_INVALID_STATE');
      await this.state.transition(
        tx,
        task.id,
        BuildTaskStatus.SUCCEEDED,
        'AGENT',
        'Agent uploaded all declared artifacts',
        {
          exitCode: 0,
          finishedAt: new Date(payload.finishedAt),
          artifactCount: BigInt(files.length),
          artifactBytes: BigInt(bytes),
          leaseHash: null,
          leaseExpiresAt: null,
          statusReason: null,
          ...(payload.sourceCommit !== undefined && task.sourceCommit === null
            ? { sourceCommit: payload.sourceCommit }
            : {}),
        },
      );
      await tx.agent.update({ where: { id: agentId }, data: { activeTaskId: null } });
      return { taskId: task.id, completed: true as const };
    });
  }

  async list(
    actor: AuthenticatedRequestUser,
    taskId: string,
    pageInput?: unknown,
    pageSizeInput?: unknown,
  ): Promise<{
    items: ArtifactResponse[];
    taskId: string;
    page: number;
    pageSize: number;
    total: number;
  }> {
    if (!UUID_PATTERN.test(taskId)) throw new ApiException('RESOURCE_NOT_FOUND');
    const page = parsePage(pageInput, 1, 1_000_000);
    const pageSize = parsePage(pageSizeInput, 20, MAX_ARTIFACT_PAGE_SIZE);
    const where = this.visibleArtifactWhere(actor, { taskId });
    const [total, items] = await this.prisma.$transaction([
      this.prisma.artifact.count({ where }),
      this.prisma.artifact.findMany({
        where,
        orderBy: [{ relativePath: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: ARTIFACT_SELECT,
      }),
    ]);
    return { items: items.map(artifactResponse), taskId, page, pageSize, total };
  }

  async download(
    actor: AuthenticatedRequestUser,
    artifactId: string,
    response: Response,
  ): Promise<void> {
    const artifact = await this.findVisibleArtifact(actor, artifactId);
    const path = await this.safeStoredPath(artifact.taskId, artifact.relativePath, false);
    let stats;
    try {
      stats = await fs.stat(path);
    } catch {
      throw new ApiException('RESOURCE_NOT_FOUND');
    }
    if (!stats.isFile() || stats.size !== safeNumber(artifact.size))
      throw new ApiException('RESOURCE_NOT_FOUND');
    const fallback = artifact.fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact';
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', String(stats.size));
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="' +
        fallback +
        "\"; filename*=UTF-8''" +
        encodeURIComponent(artifact.fileName),
    );
    try {
      await pipeline(createReadStream(path, { highWaterMark: STORAGE_CHUNK_BYTES }), response);
    } catch (_error) {
      if (response.headersSent || response.destroyed) {
        if (!response.destroyed) response.destroy();
        return;
      }
      throw new ApiException('RESOURCE_NOT_FOUND');
    }
  }

  async remove(
    actor: AuthenticatedRequestUser,
    artifactId: string,
    requestId?: string,
  ): Promise<void> {
    const artifact = await this.findVisibleArtifact(actor, artifactId);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.artifact.updateMany({
        where: { id: artifact.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (changed.count !== 1) throw new ApiException('RESOURCE_NOT_FOUND');
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'ARTIFACT_DELETED',
          resourceType: 'Artifact',
          resourceId: artifact.id,
          requestId,
          metadata: { taskId: artifact.taskId },
        },
        tx,
      );
    });
  }

  async archive(
    actor: AuthenticatedRequestUser,
    taskId: string,
    response: Response,
  ): Promise<void> {
    if (!UUID_PATTERN.test(taskId)) throw new ApiException('RESOURCE_NOT_FOUND');
    const artifacts = await this.prisma.artifact.findMany({
      where: this.visibleArtifactWhere(actor, { taskId }),
      orderBy: [{ relativePath: 'asc' }, { id: 'asc' }],
      select: { taskId: true, relativePath: true, size: true },
    });
    if (artifacts.length === 0) throw new ApiException('RESOURCE_NOT_FOUND');
    if (artifacts.length > MAX_ARTIFACT_FILES) throw new ApiException('VALIDATION_FAILED');
    const entries: { name: string; path: string }[] = [];
    for (const artifact of artifacts) {
      const path = await this.safeStoredPath(artifact.taskId, artifact.relativePath, false);
      const stats = await fs.stat(path).catch(() => undefined);
      if (!stats?.isFile() || stats.size !== safeNumber(artifact.size))
        throw new ApiException('RESOURCE_NOT_FOUND');
      entries.push({ name: artifact.relativePath, path });
    }
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', 'attachment; filename="task-' + taskId + '.zip"');
    try {
      await pipeline(Readable.from(zipEntries(entries)), response);
    } catch (_error) {
      if (response.headersSent || response.destroyed) {
        if (!response.destroyed) response.destroy();
        return;
      }
      throw new ApiException('RESOURCE_NOT_FOUND');
    }
  }

  private visibleArtifactWhere(
    actor: AuthenticatedRequestUser,
    additional: Prisma.ArtifactWhereInput,
  ): Prisma.ArtifactWhereInput {
    return this.authorization.artifactScope(actor, {
      AND: [
        additional,
        { uploadedAt: { not: null } },
        { task: { is: { status: BuildTaskStatus.SUCCEEDED } } },
      ],
    });
  }
  private async findVisibleArtifact(
    actor: AuthenticatedRequestUser,
    artifactId: string,
  ): Promise<ArtifactView> {
    if (!UUID_PATTERN.test(artifactId)) throw new ApiException('RESOURCE_NOT_FOUND');
    const artifact = await this.prisma.artifact.findFirst({
      where: this.visibleArtifactWhere(actor, { id: artifactId }),
      select: ARTIFACT_SELECT,
    });
    if (!artifact) throw new ApiException('RESOURCE_NOT_FOUND');
    return artifact;
  }
  private assertLease(
    task: {
      id: string;
      agentId: string;
      status: BuildTaskStatus;
      leaseHash: string | null;
      leaseExpiresAt: Date | null;
    } | null,
    agentId: string,
    activeTaskId: string | null,
    leaseToken: string,
    requireUploading: boolean,
  ): asserts task is {
    id: string;
    agentId: string;
    status: BuildTaskStatus;
    leaseHash: string;
    leaseExpiresAt: Date;
  } {
    if (
      !task ||
      task.agentId !== agentId ||
      activeTaskId !== task.id ||
      (requireUploading && task.status !== BuildTaskStatus.UPLOADING) ||
      !task.leaseHash ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt.getTime() <= Date.now() ||
      !this.leases.verify(leaseToken, task.leaseHash)
    )
      throw new ApiException('TASK_LEASE_INVALID');
  }
  private manifestAck(result: ManifestResult): TaskArtifactManifestAckMessage {
    return {
      id: 'artifact-manifest-ack-' + result.taskId,
      type: 'task.artifact-manifest-ack',
      timestamp: new Date().toISOString(),
      protocolVersion: 1,
      payload: {
        taskId: result.taskId,
        accepted: result.accepted,
        artifactCount: result.artifactCount,
        artifactBytes: result.artifactBytes,
      },
    };
  }
  private async prepareTaskDirectory(
    taskId: string,
    files: readonly ArtifactManifestEntry[],
  ): Promise<void> {
    for (const file of files) await this.safeStoredPath(taskId, file.relativePath, true);
  }
  private async safeStoredPath(
    taskId: string,
    relativePath: string,
    createParents: boolean,
  ): Promise<string> {
    if (!UUID_PATTERN.test(taskId)) throw invalidPath();
    const taskRoot = join(this.root, taskId);
    const segments = relativePath.split('/');
    const parents = segments.slice(0, -1);
    let current = this.root;
    if (createParents) {
      await fs.mkdir(this.root, { recursive: true });
      await this.rejectSymlink(this.root);
    } else {
      try {
        await this.rejectSymlink(this.root);
      } catch (error) {
        if (this.isNotFound(error)) return join(taskRoot, ...segments);
        throw error;
      }
    }
    const directories = [taskId, ...parents];
    for (const segment of directories) {
      current = join(current, segment);
      try {
        const stats = await fs.lstat(current);
        if (stats.isSymbolicLink() || !stats.isDirectory()) throw invalidPath();
      } catch (error) {
        if (!this.isNotFound(error)) throw error;
        if (!createParents) return join(taskRoot, ...segments);
        await fs.mkdir(current);
        await this.rejectDirectory(current);
      }
    }
    const target = join(current, segments[segments.length - 1]);
    const relativeTarget = relative(this.root, target);
    if (
      relativeTarget.startsWith('..') ||
      isAbsolute(relativeTarget) ||
      relativeTarget.split(/[\\/]+/).some((part) => part === '.' || part === '..')
    )
      throw invalidPath();
    try {
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) throw invalidPath();
    } catch (error) {
      if (!this.isNotFound(error)) throw error;
    }
    return target;
  }
  private async rejectDirectory(path: string): Promise<void> {
    const stats = await fs.lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw invalidPath();
  }
  private async rejectSymlink(path: string): Promise<void> {
    const stats = await fs.lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw invalidPath();
  }
  private async hashFile(path: string): Promise<{ size: number; sha256: string }> {
    const hash = createHash('sha256');
    let size = 0;
    const input = createReadStream(path, { highWaterMark: STORAGE_CHUNK_BYTES });
    try {
      for await (const raw of input) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        size += chunk.length;
        hash.update(chunk);
      }
    } finally {
      input.destroy();
    }
    return { size, sha256: hash.digest('hex') };
  }
  private async withUploadLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.uploadLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.uploadLocks.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.uploadLocks.get(key) === current) this.uploadLocks.delete(key);
    }
  }
  private isNotFound(error: unknown): boolean {
    return this.errorCode(error) === 'ENOENT';
  }
  private errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined;
  }
}
