import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// dist/esm 中是 ES Module，但包根 package.json 需要继续保持 CommonJS，
// 因此写入目录级标记，让 Node 与打包器按 ESM 解析该目录。
const target = fileURLToPath(new URL('../dist/esm/package.json', import.meta.url));
const esmRoot = dirname(target);

writeFileSync(target, `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');

// TypeScript 的 Bundler 模式允许无扩展相对导入，但 Node 原生 ESM 要求明确的
// .js 或 /index.js。只改写确实能在 dist/esm 中解析到的本地模块，不触碰包名导入。
function rewriteImports(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      rewriteImports(path);
      continue;
    }
    if (!path.endsWith('.js')) continue;

    const source = readFileSync(path, 'utf8');
    const rewritten = source.replace(
      /((?:from|import)\s*['"])(\.\.?\/[^'"]+)(['"])/g,
      (full, prefix, specifier, suffix) => {
        if (specifier.endsWith('.js') || specifier.endsWith('.json')) return full;
        const fileCandidate = resolve(dirname(path), `${specifier}.js`);
        if (existsSync(fileCandidate)) return `${prefix}${specifier}.js${suffix}`;
        const indexCandidate = resolve(dirname(path), specifier, 'index.js');
        if (existsSync(indexCandidate)) return `${prefix}${specifier}/index.js${suffix}`;
        return full;
      },
    );

    if (rewritten !== source) writeFileSync(path, rewritten, 'utf8');
  }
}

rewriteImports(esmRoot);
