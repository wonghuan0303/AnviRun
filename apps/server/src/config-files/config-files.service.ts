import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { basename, join, parse, resolve } from 'node:path';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Response } from 'express';
import {
  fileMatchesField,
  FORM_FILE_DEFAULT_MAX_BYTES,
  validateFormSchema,
  type FileConfigValue,
} from '@anvilrun/contracts';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '@prisma/client';
import {
  validateFormConfigValues,
  type FormConfigValues,
  type FormSchema,
} from '@anvilrun/contracts';

const UUID = /^[0-9a-f-]{36}$/i;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

@Injectable()
export class ConfigFilesService implements OnModuleInit, OnModuleDestroy {
  private readonly root = resolve(
    process.env.CONFIG_FILE_STORAGE_ROOT ?? join(process.cwd(), 'data', 'config-files'),
  );
  private cleanupTimer?: NodeJS.Timeout;
  constructor(private readonly prisma: PrismaService) {
    if (parse(this.root).root === this.root)
      throw new Error('CONFIG_FILE_STORAGE_ROOT must not be a filesystem root');
  }

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => void this.cleanupExpired(), 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async cleanupExpired(): Promise<void> {
    const rows = await this.prisma.configFile
      .findMany({
        where: { projectId: null, expiresAt: { lt: new Date() }, taskInputs: { none: {} } },
        select: { id: true, storagePath: true },
        take: 100,
      })
      .catch(() => []);
    for (const row of rows) {
      await fs.rm(row.storagePath, { force: true }).catch(() => undefined);
      await this.prisma.configFile
        .deleteMany({ where: { id: row.id, projectId: null, taskInputs: { none: {} } } })
        .catch(() => undefined);
    }
  }

  async upload(
    actor: AuthenticatedRequestUser,
    templateId: string,
    fieldName: string,
    fileName: string,
    contentType: string | undefined,
    contentLength: string | undefined,
    body: AsyncIterable<Buffer | string>,
  ) {
    if (!UUID.test(templateId) || !this.safeName(fileName))
      throw new ApiException('CONFIG_FILE_INVALID');
    const template = await this.prisma.buildTemplate.findUnique({
      where: { id: templateId },
      select: { enabled: true, formSchema: true },
    });
    const checked = validateFormSchema(template?.formSchema);
    const field = checked.ok
      ? checked.value.find((item) => item.name === fieldName && item.type === 'file')
      : undefined;
    if (!template?.enabled || !field || field.type !== 'file')
      throw new ApiException('CONFIG_FILE_INVALID');
    const declared = Number(contentLength);
    const max = Math.min(
      field.maxSizeBytes ?? FORM_FILE_DEFAULT_MAX_BYTES,
      Number(process.env.CONFIG_FILE_UPLOAD_MAX_BYTES ?? Number.MAX_SAFE_INTEGER),
    );
    if (!Number.isSafeInteger(declared) || declared < 0)
      throw new ApiException('CONFIG_FILE_INVALID');
    if (declared > max) throw new ApiException('CONFIG_FILE_TOO_LARGE');
    if (!fileMatchesField(field, fileName, declared)) throw new ApiException('CONFIG_FILE_INVALID');

    const id = randomUUID();
    const directory = join(this.root, actor.id);
    const temporary = join(directory, `${id}.part`);
    const finalPath = join(directory, id);
    await fs.mkdir(directory, { recursive: true });
    const handle = await fs.open(temporary, 'wx');
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const value of body) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > max || size > declared) throw new ApiException('CONFIG_FILE_TOO_LARGE');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten;
      }
      if (size !== declared) throw new ApiException('CONFIG_FILE_INVALID');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await fs.rename(temporary, finalPath);
    try {
      const row = await this.prisma.configFile.create({
        data: {
          id,
          ownerId: actor.id,
          buildTemplateId: templateId,
          fieldName,
          originalName: fileName,
          size: BigInt(size),
          sha256: hash.digest('hex'),
          storagePath: finalPath,
          contentType: contentType?.slice(0, 255),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      return { file: this.publicValue(row) };
    } catch (error) {
      await fs.rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async downloadForAgent(
    taskId: string,
    fileId: string,
    token: string,
    response: Response,
  ): Promise<void> {
    if (!UUID.test(taskId) || !UUID.test(fileId) || !token)
      throw new ApiException('TASK_LEASE_INVALID');
    const input = await this.prisma.buildTaskInputFile.findFirst({
      where: { taskId, configFileId: fileId },
      include: {
        task: {
          select: {
            leaseHash: true,
            leaseExpiresAt: true,
            agent: { select: { activeTaskId: true } },
          },
        },
        configFile: { select: { storagePath: true } },
      },
    });
    const actual = Buffer.from(createHash('sha256').update(token).digest('hex'));
    const expected = Buffer.from(input?.task.leaseHash ?? '');
    if (
      !input ||
      input.task.agent.activeTaskId !== taskId ||
      !input.task.leaseExpiresAt ||
      input.task.leaseExpiresAt <= new Date() ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new ApiException('TASK_LEASE_INVALID');
    const stats = await fs.lstat(input.configFile.storagePath).catch(() => undefined);
    if (!stats?.isFile() || stats.isSymbolicLink() || stats.size !== Number(input.size))
      throw new ApiException('CONFIG_FILE_REFERENCE_INVALID');
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', input.size.toString());
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(input.configFile.storagePath);
      stream.on('error', reject);
      response.on('error', reject);
      response.on('finish', resolvePromise);
      stream.pipe(response);
    });
  }

  publicValue(file: {
    id: string;
    originalName: string;
    size: bigint;
    sha256: string;
  }): FileConfigValue {
    return {
      fileId: file.id,
      fileName: file.originalName,
      size: Number(file.size),
      sha256: file.sha256,
    };
  }

  async canonicalizeConfig(
    transaction: Prisma.TransactionClient,
    ownerId: string,
    projectId: string | null,
    templateId: string,
    schema: FormSchema,
    input: unknown,
  ): Promise<{ config: FormConfigValues; fileIds: string[] }> {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new ApiException('PROJECT_CONFIG_INVALID');
    const next: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    const fileIds: string[] = [];
    for (const field of schema) {
      if (field.type !== 'file' || next[field.name] === undefined || next[field.name] === null)
        continue;
      const candidate = next[field.name];
      const fileId =
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        typeof (candidate as Record<string, unknown>).fileId === 'string'
          ? (candidate as Record<string, string>).fileId
          : '';
      const file = UUID.test(fileId)
        ? await transaction.configFile.findUnique({ where: { id: fileId } })
        : null;
      const attachedToCurrentProject = projectId !== null && file?.projectId === projectId;
      const validPendingOwner = file?.projectId === null && file.ownerId === ownerId;
      if (
        !file ||
        (!attachedToCurrentProject && !validPendingOwner) ||
        file.buildTemplateId !== templateId ||
        file.fieldName !== field.name ||
        (file.projectId === null && (!file.expiresAt || file.expiresAt <= new Date())) ||
        !fileMatchesField(field, file.originalName, Number(file.size))
      )
        throw new ApiException('CONFIG_FILE_REFERENCE_INVALID');
      next[field.name] = this.publicValue(file);
      fileIds.push(file.id);
    }
    const checked = validateFormConfigValues(schema, next);
    if (!checked.ok)
      throw new ApiException('PROJECT_CONFIG_INVALID', {
        details: {
          issues: checked.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            pointer: issue.pointer,
          })),
        },
      });
    return { config: checked.value, fileIds };
  }

  async bindFiles(
    transaction: Prisma.TransactionClient,
    ownerId: string,
    projectId: string,
    fileIds: readonly string[],
  ): Promise<void> {
    if (fileIds.length === 0) return;
    const changed = await transaction.configFile.updateMany({
      where: {
        id: { in: [...fileIds] },
        OR: [{ ownerId, projectId: null }, { projectId }],
      },
      data: { projectId, expiresAt: null, detachedAt: null },
    });
    if (changed.count !== new Set(fileIds).size)
      throw new ApiException('CONFIG_FILE_REFERENCE_INVALID');
  }

  async reconcileProjectFiles(
    transaction: Prisma.TransactionClient,
    ownerId: string,
    projectId: string,
    fileIds: readonly string[],
  ): Promise<void> {
    await this.bindFiles(transaction, ownerId, projectId, fileIds);
    await transaction.configFile.updateMany({
      where: {
        projectId,
        ...(fileIds.length === 0 ? {} : { id: { notIn: [...new Set(fileIds)] } }),
      },
      data: {
        projectId: null,
        detachedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  }

  private safeName(value: string): boolean {
    const hasControlCharacter = Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
    return (
      value === basename(value) &&
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !hasControlCharacter &&
      Buffer.byteLength(value, 'utf8') <= 255 &&
      !RESERVED.test(value)
    );
  }
}
