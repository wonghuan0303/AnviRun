import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.argv[2] ?? 'success';
const config = JSON.parse(await readFile(join(process.cwd(), 'platform.config.json'), 'utf8'));

process.stdout.write(`e2e fixture stdout mode=${mode}\n`);
console.error('e2e fixture stderr');

if (mode === 'cancel') {
  process.stdout.write('e2e fixture waiting for cancellation\n');
  await new Promise(() => {});
}

if (mode === 'nonzero') {
  process.exitCode = 17;
} else if (mode === 'empty') {
  await mkdir(join('dist', 'empty-directory'), { recursive: true });
} else if (mode === 'success') {
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  await mkdir(join('dist', 'nested', 'unicode'), { recursive: true });
  await mkdir(join('dist', 'empty-directory'), { recursive: true });
  await writeFile(join('dist', 'branch.txt'), `${branch}\n`, 'utf8');
  await writeFile(
    join('dist', 'nested', 'unicode', '结果 文件.txt'),
    `fixture artifact channel=${String(config.channel)} retries=${String(config.retries)}\n`,
    'utf8',
  );
  await writeFile(
    join('dist', 'platform-config-copy.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
} else {
  console.error(`unknown fixture mode: ${mode}`);
  process.exitCode = 19;
}
