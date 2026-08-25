import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { PrismaClient, UserRole } from '@prisma/client';

import { normalizeUsername } from '../database/username';
import { PasswordService, validatePasswordInput } from '../auth/password.service';

export interface InitializedAdmin {
  id: string;
  username: string;
}

/** 使用 PostgreSQL advisory lock 保证并发运行时最多初始化一个管理员。 */
export async function initializeFirstAdmin(
  prisma: PrismaClient,
  input: { username: string; password: string },
): Promise<InitializedAdmin> {
  const username = normalizeUsername(input.username);
  validatePasswordInput(input.password);
  const passwordHash = await new PasswordService().hash(input.password);

  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(76123981234)`;
    const adminCount = await transaction.user.count({ where: { role: UserRole.ADMIN } });
    if (adminCount > 0) throw new Error('an administrator already exists');

    const user = await transaction.user.create({
      data: { username, passwordHash, role: UserRole.ADMIN },
    });
    await transaction.auditLog.create({
      data: {
        actorId: user.id,
        action: 'ADMIN_INITIALIZED',
        resourceType: 'User',
        resourceId: user.id,
        metadata: { outcome: 'created' },
      },
    });
    return { id: user.id, username: user.username };
  });
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function readHiddenPassword(): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      input.setEncoding('utf8');
      input.on('data', (chunk: string) => {
        value += chunk;
      });
      input.on('end', () => resolve(value.replace(/\r?\n$/, '')));
      input.on('error', reject);
    });
  }

  output.write('Password: ');
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text === '\u0003') {
        input.setRawMode(false);
        reject(new Error('cancelled'));
        return;
      }
      if (text === '\r' || text === '\n') {
        input.setRawMode(false);
        output.write('\n');
        input.off('data', onData);
        resolve(value);
        return;
      }
      if (text === '\u007f') {
        value = value.slice(0, -1);
        return;
      }
      value += text;
    };
    input.on('data', onData);
  });
}

async function readUsername(args: string[]): Promise<string> {
  const fromArgs = optionValue(args, '--username');
  if (fromArgs) return fromArgs;
  const readline = createInterface({ input, output });
  try {
    return await readline.question('Username: ');
  } finally {
    readline.close();
  }
}

export async function runInitAdmin(args = process.argv.slice(2)): Promise<void> {
  if (args.some((arg) => arg === '--password' || arg.startsWith('--password='))) {
    throw new Error('password must be supplied through hidden input or --password-stdin');
  }
  const username = await readUsername(args);
  const password = args.includes('--password-stdin')
    ? await readHiddenPassword()
    : await readHiddenPassword();
  const prisma = new PrismaClient();
  try {
    const admin = await initializeFirstAdmin(prisma, { username, password });
    process.stdout.write(`Administrator initialized: id=${admin.id} username=${admin.username}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runInitAdmin().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'initialization failed';
    console.error(`Administrator initialization failed: ${message}`);
    process.exitCode = 1;
  });
}
