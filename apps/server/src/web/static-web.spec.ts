import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';

import { assertWebStaticRoot, configureWebStaticHosting, shouldUseSpaFallback } from './static-web';

describe('web static hosting', () => {
  it.each(['/', '/projects', '/projects/123'])('uses SPA fallback for %s', (path) => {
    expect(shouldUseSpaFallback({ method: 'GET', path })).toBe(true);
  });

  it.each(['/api/projects', '/health/ready', '/ws/client'])(
    'does not fallback reserved path %s',
    (path) => {
      expect(shouldUseSpaFallback({ method: 'GET', path })).toBe(false);
    },
  );

  it('does not fallback missing resources with an extension', () => {
    expect(shouldUseSpaFallback({ method: 'GET', path: '/assets/missing.js' })).toBe(false);
    expect(shouldUseSpaFallback({ method: 'GET', path: '/assets/missing.css' })).toBe(false);
  });

  it('registers static assets and fallback only after validating index.html', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'buildplatform-web-'));
    await fs.writeFile(join(root, 'index.html'), '<!doctype html>', 'utf8');
    const useStaticAssets = jest.fn();
    const use = jest.fn();

    await configureWebStaticHosting(
      { useStaticAssets, use } as unknown as NestExpressApplication,
      root,
    );

    expect(useStaticAssets).toHaveBeenCalledWith(root, { index: false });
    expect(use).toHaveBeenCalledTimes(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a static root without a readable index.html', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'buildplatform-web-'));

    await expect(assertWebStaticRoot(root)).rejects.toThrow(
      'WEB_STATIC_ROOT must contain a readable index.html',
    );
    await fs.rm(root, { recursive: true, force: true });
  });
});
