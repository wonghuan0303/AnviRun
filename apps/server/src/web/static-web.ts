import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

export interface StaticWebConfiguration {
  readonly root: string;
  readonly indexFile: string;
}

export function resolveWebStaticRoot(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : undefined;
}

/** 启动前验证静态目录和 SPA 入口，错误消息不包含本地路径。 */
export async function assertWebStaticRoot(root: string): Promise<StaticWebConfiguration> {
  try {
    const directory = await fs.stat(root);
    const indexFile = resolve(root, 'index.html');
    const index = await fs.stat(indexFile);
    if (!directory.isDirectory() || !index.isFile()) throw new Error('invalid static root');
    await fs.access(indexFile, constants.R_OK);
    return { root, indexFile };
  } catch {
    throw new Error('WEB_STATIC_ROOT must contain a readable index.html');
  }
}

function isReservedPath(path: string): boolean {
  return (
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/health' ||
    path.startsWith('/health/') ||
    path === '/ws' ||
    path.startsWith('/ws/')
  );
}

export function shouldUseSpaFallback(request: Pick<Request, 'method' | 'path'>): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (isReservedPath(request.path)) return false;
  return extname(request.path) === '';
}

/** 使用 Express 静态中间件托管 Web，并为 Vue history 路由回退到 index.html。 */
export async function configureWebStaticHosting(
  app: NestExpressApplication,
  configuredRoot: string | undefined,
): Promise<void> {
  const root = resolveWebStaticRoot(configuredRoot);
  if (!root) return;
  await assertWebStaticRoot(root);
  app.useStaticAssets(root, { index: false });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!shouldUseSpaFallback(request)) {
      next();
      return;
    }
    response.sendFile('index.html', { root }, (error) => {
      if (error) next(error);
    });
  });
}
