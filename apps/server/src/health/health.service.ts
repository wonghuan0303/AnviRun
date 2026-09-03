import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { getContractsPackageInfo } from '@anvilrun/contracts';

import { SERVICE_NAME } from '../config/server.config';
import { PrismaService } from '../database/prisma.service';
import { assertWebStaticRoot, resolveWebStaticRoot } from '../web/static-web';

/** 最小健康检查响应。 */
export interface HealthStatus {
  status: 'ok';
  service: string;
  contracts: {
    name: string;
    version: string;
  };
  uptimeSeconds: number;
}

/** 存活探针响应。 */
export interface LivenessStatus {
  status: 'ok';
}

export type ReadinessComponentStatus = 'ok' | 'unavailable' | 'disabled';

export interface ReadinessComponent {
  readonly status: ReadinessComponentStatus;
  readonly message?: string;
}

export interface ReadinessStatus {
  readonly status: 'ok' | 'unavailable';
  readonly database: ReadinessComponent;
  readonly taskLogs: ReadinessComponent;
  readonly artifacts: ReadinessComponent;
  readonly web: ReadinessComponent;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 返回服务基础状态。
   *
   * 该接口只报告 Node 进程自身是否仍可响应，不依赖数据库或磁盘。
   */
  getStatus(): HealthStatus {
    const contracts = getContractsPackageInfo();

    return {
      status: 'ok',
      service: SERVICE_NAME,
      contracts: {
        name: contracts.name,
        version: contracts.version,
      },
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  getLiveness(): LivenessStatus {
    return { status: 'ok' };
  }

  async getReadiness(): Promise<ReadinessStatus> {
    const [database, taskLogs, artifacts, web] = await Promise.all([
      this.checkDatabase(),
      this.checkDirectory(process.env.TASK_LOG_ROOT ?? join(process.cwd(), 'data', 'task-logs')),
      this.checkDirectory(
        process.env.ARTIFACT_STORAGE_ROOT ?? join(process.cwd(), 'data', 'artifacts'),
      ),
      this.checkWeb(),
    ]);
    const components = [database, taskLogs, artifacts, web];
    return {
      status: components.every((component) => component.status !== 'unavailable')
        ? 'ok'
        : 'unavailable',
      database,
      taskLogs,
      artifacts,
      web,
    };
  }

  private async checkDatabase(): Promise<ReadinessComponent> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return { status: 'unavailable', message: 'database query failed' };
    }
  }

  private async checkDirectory(configuredRoot: string): Promise<ReadinessComponent> {
    const root = resolve(configuredRoot);
    if (parse(root).root === root) {
      return { status: 'unavailable', message: 'storage path unavailable' };
    }
    try {
      await probeWritableDirectory(root);
      return { status: 'ok' };
    } catch {
      return { status: 'unavailable', message: 'storage probe failed' };
    }
  }

  private async checkWeb(): Promise<ReadinessComponent> {
    const root = resolveWebStaticRoot(process.env.WEB_STATIC_ROOT);
    if (!root) return { status: 'disabled' };
    try {
      await assertWebStaticRoot(root);
      return { status: 'ok' };
    } catch {
      return { status: 'unavailable', message: 'web index unavailable' };
    }
  }
}

export async function probeWritableDirectory(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const probePath = join(root, `.buildplatform-readiness-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      probePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile('ok', 'utf8');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(probePath, { force: false });
  }
}
