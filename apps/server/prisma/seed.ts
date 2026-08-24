import { PrismaClient } from '@prisma/client';

import { normalizeUsername } from '../src/database/username';

const prisma = new PrismaClient();

const SEED_USER_ID = '00000000-0000-4000-8000-000000000011';
const SEED_AGENT_ID = '00000000-0000-4000-8000-000000000012';
const SEED_TEMPLATE_ID = '00000000-0000-4000-8000-000000000013';
const SEED_PROJECT_ID = '00000000-0000-4000-8000-000000000014';

async function main(): Promise<void> {
  const user = await prisma.user.upsert({
    where: { id: SEED_USER_ID },
    update: {
      username: normalizeUsername('seed-disabled-user'),
      passwordHash: 'seed-disabled-placeholder-hash',
      role: 'USER',
      status: 'DISABLED',
      tokenVersion: 0,
    },
    create: {
      id: SEED_USER_ID,
      username: normalizeUsername('seed-disabled-user'),
      passwordHash: 'seed-disabled-placeholder-hash',
      role: 'USER',
      status: 'DISABLED',
      tokenVersion: 0,
    },
  });

  const agent = await prisma.agent.upsert({
    where: { id: SEED_AGENT_ID },
    update: {
      name: 'seed-agent',
      tokenHash: 'seed-agent-token-hash-placeholder',
      enabled: true,
      status: 'OFFLINE',
      activeTaskId: null,
    },
    create: {
      id: SEED_AGENT_ID,
      name: 'seed-agent',
      tokenHash: 'seed-agent-token-hash-placeholder',
      enabled: true,
      status: 'OFFLINE',
    },
  });

  const template = await prisma.buildTemplate.upsert({
    where: {
      agentId_name: {
        agentId: agent.id,
        name: 'seed-template',
      },
    },
    update: {
      description: 'T1.1 database relationship seed',
      gitUrl: 'https://example.invalid/buildplatform/seed.git',
      command: 'echo buildplatform-seed',
      artifactDir: 'dist',
      formSchema: [],
      timeoutSeconds: 3600,
      enabled: true,
      createdBy: user.id,
    },
    create: {
      id: SEED_TEMPLATE_ID,
      name: 'seed-template',
      description: 'T1.1 database relationship seed',
      agentId: agent.id,
      gitUrl: 'https://example.invalid/buildplatform/seed.git',
      command: 'echo buildplatform-seed',
      artifactDir: 'dist',
      formSchema: [],
      timeoutSeconds: 3600,
      enabled: true,
      createdBy: user.id,
    },
  });

  await prisma.project.upsert({
    where: { id: SEED_PROJECT_ID },
    update: {
      ownerId: user.id,
      buildTemplateId: template.id,
      name: 'seed-project',
      description: 'T1.1 database relationship seed',
      branch: 'main',
      config: {},
      deletedAt: null,
    },
    create: {
      id: SEED_PROJECT_ID,
      ownerId: user.id,
      buildTemplateId: template.id,
      name: 'seed-project',
      description: 'T1.1 database relationship seed',
      branch: 'main',
      config: {},
    },
  });

  console.warn('T1.1 seed completed: disabled user, agent, template, and project');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
