import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// dist/esm 中是 ES Module，但包根 package.json 没有声明 "type": "module"
// （Server 侧需要 CommonJS 入口），因此写入目录级标记，
// 让 Node 与打包器把该目录内的 .js 当作 ESM 解析。
const target = fileURLToPath(new URL('../dist/esm/package.json', import.meta.url));

writeFileSync(target, `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
