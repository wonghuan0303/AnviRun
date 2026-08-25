import { randomUUID } from 'node:crypto';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import request, { type Response } from 'supertest';

import { AccessTokenGuard } from '../../src/auth/access-token.guard';
import { AdminGuard } from '../../src/auth/admin.guard';
import { AuthModule } from '../../src/auth/auth.module';
import { CurrentUser } from '../../src/auth/current-user.decorator';
import type { AuthenticatedRequestUser } from '../../src/auth/auth.types';
import { LoginRateLimiterService } from '../../src/auth/rate-limiter.service';
import { PasswordService } from '../../src/auth/password.service';
import { AuthorizationModule } from '../../src/authorization/authorization.module';
import { AuthorizationService } from '../../src/authorization/authorization.service';
import { OwnedResource } from '../../src/authorization/owned-resource.decorator';
import { OwnershipGuard } from '../../src/authorization/ownership.guard';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/database/prisma.service';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('/buildplatform_test')) {
  throw new Error('Authorization integration tests require buildplatform_test');
}

@Controller('test/authorization')
class AuthorizationTestController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  @Get('admin')
  @UseGuards(AccessTokenGuard, AdminGuard)
  adminOnly(): { allowed: true } {
    return { allowed: true };
  }

  @Get('projects')
  @UseGuards(AccessTokenGuard)
  async listProjects(
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Query('ownerId') requestedOwnerId?: string,
  ): Promise<string[]> {
    const rows = await this.prisma.project.findMany({
      where: this.authorization.projectScope(
        actor,
        requestedOwnerId ? { ownerId: requestedOwnerId } : {},
      ),
      orderBy: { name: 'asc' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  @Get('tasks')
  @UseGuards(AccessTokenGuard)
  async listTasks(@CurrentUser() actor: AuthenticatedRequestUser): Promise<string[]> {
    const rows = await this.prisma.buildTask.findMany({
      where: this.authorization.taskScope(actor),
      select: { id: true },
    });
    return rows.map((row) => row.id).sort();
  }

  @Get('artifacts')
  @UseGuards(AccessTokenGuard)
  async listArtifacts(@CurrentUser() actor: AuthenticatedRequestUser): Promise<string[]> {
    const rows = await this.prisma.artifact.findMany({
      where: this.authorization.artifactScope(actor),
      select: { id: true },
    });
    return rows.map((row) => row.id).sort();
  }
  @Get('projects/:projectId')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('project', 'projectId')
  project(): { allowed: true } {
    return { allowed: true };
  }

  @Get('tasks/:taskId')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('task', 'taskId')
  task(): { allowed: true } {
    return { allowed: true };
  }

  @Get('task-logs/:taskId')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('taskLog', 'taskId')
  taskLog(): { allowed: true } {
    return { allowed: true };
  }

  @Get('artifacts/:artifactId')
  @UseGuards(AccessTokenGuard, OwnershipGuard)
  @OwnedResource('artifact', 'artifactId')
  artifact(): { allowed: true } {
    return { allowed: true };
  }
}

describe('T1.3 RBAC and Project ownership PostgreSQL integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminId: string;
  let userAId: string;
  let userBId: string;
  let adminPassword: string;
  let userAPassword: string;
  let userBPassword: string;
  let projectAId: string;
  let projectBId: string;
  let deletedProjectId: string;
  let taskAId: string;
  let taskBId: string;
  let deletedTaskId: string;
  let artifactAId: string;
  let artifactBId: string;
  let deletedArtifactId: string;
  let userAUsername: string;
  let userBUsername: string;

  async function resetDatabase(): Promise<void> {
    await prisma.agent.updateMany({ data: { activeTaskId: null } });
    await prisma.artifact.deleteMany();
    await prisma.buildTask.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.project.deleteMany();
    await prisma.buildTemplate.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.user.deleteMany();
  }

  async function login(username: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username, password });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  function resourcePaths(input: {
    projectId: string;
    taskId: string;
    artifactId: string;
  }): string[] {
    return [
      `/test/authorization/projects/${input.projectId}`,
      `/test/authorization/tasks/${input.taskId}`,
      `/test/authorization/task-logs/${input.taskId}`,
      `/test/authorization/artifacts/${input.artifactId}`,
    ];
  }

  async function getAll(token: string, paths: string[]): Promise<Response[]> {
    return Promise.all(
      paths.map((path) =>
        request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`),
      ),
    );
  }

  function expectAllowed(responses: Response[]): void {
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ allowed: true });
    }
  }

  function expectSafeNotFound(response: Response): void {
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('ownerId');
    expect(serialized).not.toContain(userAUsername);
    expect(serialized).not.toContain(userBUsername);
    expect(serialized).not.toContain('storagePath');
    expect(serialized).not.toContain('Prisma');
    expect(serialized).not.toContain('PostgreSQL');
    expect(serialized).not.toContain('at ');
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule, AuthModule, AuthorizationModule],
      controllers: [AuthorizationTestController],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDatabase();
    const passwords = new PasswordService();
    adminPassword = 'Admin authorization password 🔐';
    userAPassword = 'User A authorization password 🔐';
    userBPassword = 'User B authorization password 🔐';
    userAUsername = 'owner-a';
    userBUsername = 'owner-b';

    const admin = await prisma.user.create({
      data: {
        username: 'admin',
        passwordHash: await passwords.hash(adminPassword),
        role: UserRole.ADMIN,
      },
    });
    const userA = await prisma.user.create({
      data: { username: userAUsername, passwordHash: await passwords.hash(userAPassword) },
    });
    const userB = await prisma.user.create({
      data: { username: userBUsername, passwordHash: await passwords.hash(userBPassword) },
    });
    adminId = admin.id;
    userAId = userA.id;
    userBId = userB.id;

    const agent = await prisma.agent.create({ data: { name: 'authorization-agent' } });
    const template = await prisma.buildTemplate.create({
      data: {
        name: 'authorization-template',
        agentId: agent.id,
        gitUrl: 'https://example.invalid/authorization.git',
        command: 'echo authorization',
        artifactDir: 'dist',
        formSchema: [],
        createdBy: adminId,
      },
    });
    const projectA = await prisma.project.create({
      data: {
        ownerId: userAId,
        buildTemplateId: template.id,
        name: 'project-a',
        branch: 'main',
        config: {},
      },
    });
    const projectB = await prisma.project.create({
      data: {
        ownerId: userBId,
        buildTemplateId: template.id,
        name: 'project-b',
        branch: 'main',
        config: {},
      },
    });
    const deletedProject = await prisma.project.create({
      data: {
        ownerId: userAId,
        buildTemplateId: template.id,
        name: 'project-deleted',
        branch: 'main',
        config: {},
        deletedAt: new Date(),
      },
    });
    const taskA = await prisma.buildTask.create({
      data: {
        projectId: projectA.id,
        buildTemplateId: template.id,
        agentId: agent.id,
        createdBy: userBId,
        branch: 'main',
        config: {},
      },
    });
    const taskB = await prisma.buildTask.create({
      data: {
        projectId: projectB.id,
        buildTemplateId: template.id,
        agentId: agent.id,
        createdBy: userAId,
        branch: 'main',
        config: {},
      },
    });
    const deletedTask = await prisma.buildTask.create({
      data: {
        projectId: deletedProject.id,
        buildTemplateId: template.id,
        agentId: agent.id,
        createdBy: userBId,
        branch: 'main',
        config: {},
      },
    });
    const artifactA = await prisma.artifact.create({
      data: {
        taskId: taskA.id,
        relativePath: 'dist/a.zip',
        fileName: 'a.zip',
        size: 1,
        sha256: 'a'.repeat(64),
        storagePath: 'C:\\private\\owner-a\\a.zip',
      },
    });
    const artifactB = await prisma.artifact.create({
      data: {
        taskId: taskB.id,
        relativePath: 'dist/b.zip',
        fileName: 'b.zip',
        size: 1,
        sha256: 'b'.repeat(64),
        storagePath: 'C:\\private\\owner-b\\b.zip',
      },
    });
    const deletedArtifact = await prisma.artifact.create({
      data: {
        taskId: deletedTask.id,
        relativePath: 'dist/deleted.zip',
        fileName: 'deleted.zip',
        size: 1,
        sha256: 'c'.repeat(64),
        storagePath: 'C:\\private\\deleted\\deleted.zip',
      },
    });

    projectAId = projectA.id;
    projectBId = projectB.id;
    deletedProjectId = deletedProject.id;
    taskAId = taskA.id;
    taskBId = taskB.id;
    deletedTaskId = deletedTask.id;
    artifactAId = artifactA.id;
    artifactBId = artifactB.id;
    deletedArtifactId = deletedArtifact.id;
    app.get(LoginRateLimiterService).reset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows ADMIN and each owner to access the correct Project-derived resources', async () => {
    const adminToken = await login('admin', adminPassword);
    const userAToken = await login(userAUsername, userAPassword);
    const userBToken = await login(userBUsername, userBPassword);

    expectAllowed(
      await getAll(
        adminToken,
        resourcePaths({ projectId: projectAId, taskId: taskAId, artifactId: artifactAId }),
      ),
    );
    expectAllowed(
      await getAll(
        adminToken,
        resourcePaths({ projectId: projectBId, taskId: taskBId, artifactId: artifactBId }),
      ),
    );
    expectAllowed(
      await getAll(
        userAToken,
        resourcePaths({ projectId: projectAId, taskId: taskAId, artifactId: artifactAId }),
      ),
    );
    expectAllowed(
      await getAll(
        userBToken,
        resourcePaths({ projectId: projectBId, taskId: taskBId, artifactId: artifactBId }),
      ),
    );
  });

  it('returns identical safe 404s for cross-user and unknown resources', async () => {
    const userAToken = await login(userAUsername, userAPassword);
    const userBToken = await login(userBUsername, userBPassword);
    const crossUser = await getAll(
      userAToken,
      resourcePaths({ projectId: projectBId, taskId: taskBId, artifactId: artifactBId }),
    );
    const unknown = await getAll(
      userAToken,
      resourcePaths({ projectId: randomUUID(), taskId: randomUUID(), artifactId: randomUUID() }),
    );
    const userBCrossUser = await getAll(
      userBToken,
      resourcePaths({ projectId: projectAId, taskId: taskAId, artifactId: artifactAId }),
    );

    for (const response of [...crossUser, ...unknown, ...userBCrossUser]) {
      expectSafeNotFound(response);
    }
    for (let index = 0; index < crossUser.length; index += 1) {
      expect(crossUser[index].status).toBe(unknown[index].status);
      expect(crossUser[index].body.code).toBe(unknown[index].body.code);
      expect(crossUser[index].body.message).toBe(unknown[index].body.message);
    }
  });

  it('rejects invalid UUIDs without a 500 or database error', async () => {
    const token = await login(userAUsername, userAPassword);
    const responses = await getAll(
      token,
      resourcePaths({ projectId: 'not-a-uuid', taskId: 'not-a-uuid', artifactId: 'not-a-uuid' }),
    );
    for (const response of responses) expectSafeNotFound(response);
  });

  it('injects owner scope into list queries and prevents ownerId override', async () => {
    const adminToken = await login('admin', adminPassword);
    const userAToken = await login(userAUsername, userAPassword);
    const userBToken = await login(userBUsername, userBPassword);

    const userAProjects = await request(app.getHttpServer())
      .get('/test/authorization/projects')
      .set('Authorization', `Bearer ${userAToken}`);
    const userAWithBFilter = await request(app.getHttpServer())
      .get(`/test/authorization/projects?ownerId=${userBId}`)
      .set('Authorization', `Bearer ${userAToken}`);
    const userBProjects = await request(app.getHttpServer())
      .get('/test/authorization/projects')
      .set('Authorization', `Bearer ${userBToken}`);
    const adminProjects = await request(app.getHttpServer())
      .get('/test/authorization/projects')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(userAProjects.body).toEqual([projectAId]);
    expect(userAWithBFilter.body).toEqual([]);
    expect(userBProjects.body).toEqual([projectBId]);
    expect(adminProjects.body).toEqual([projectAId, projectBId]);
    expect(adminProjects.body).not.toContain(deletedProjectId);

    const [userATasks, userBTasks, adminTasks] = await Promise.all([
      request(app.getHttpServer())
        .get('/test/authorization/tasks')
        .set('Authorization', `Bearer ${userAToken}`),
      request(app.getHttpServer())
        .get('/test/authorization/tasks')
        .set('Authorization', `Bearer ${userBToken}`),
      request(app.getHttpServer())
        .get('/test/authorization/tasks')
        .set('Authorization', `Bearer ${adminToken}`),
    ]);
    expect(userATasks.body).toEqual([taskAId].sort());
    expect(userBTasks.body).toEqual([taskBId].sort());
    expect(adminTasks.body).toEqual([taskAId, taskBId].sort());
    expect(adminTasks.body).not.toContain(deletedTaskId);

    const [userAArtifacts, userBArtifacts, adminArtifacts] = await Promise.all([
      request(app.getHttpServer())
        .get('/test/authorization/artifacts')
        .set('Authorization', `Bearer ${userAToken}`),
      request(app.getHttpServer())
        .get('/test/authorization/artifacts')
        .set('Authorization', `Bearer ${userBToken}`),
      request(app.getHttpServer())
        .get('/test/authorization/artifacts')
        .set('Authorization', `Bearer ${adminToken}`),
    ]);
    expect(userAArtifacts.body).toEqual([artifactAId].sort());
    expect(userBArtifacts.body).toEqual([artifactBId].sort());
    expect(adminArtifacts.body).toEqual([artifactAId, artifactBId].sort());
    expect(adminArtifacts.body).not.toContain(deletedArtifactId);
  });

  it('excludes soft-deleted Projects and inherited Task/Artifact resources', async () => {
    const adminToken = await login('admin', adminPassword);
    const userAToken = await login(userAUsername, userAPassword);
    const paths = resourcePaths({
      projectId: deletedProjectId,
      taskId: deletedTaskId,
      artifactId: deletedArtifactId,
    });
    for (const response of [
      ...(await getAll(adminToken, paths)),
      ...(await getAll(userAToken, paths)),
    ]) {
      expectSafeNotFound(response);
    }
  });

  it('preserves authentication ordering and AdminGuard behavior', async () => {
    const adminToken = await login('admin', adminPassword);
    const userAToken = await login(userAUsername, userAPassword);
    const unauthenticated = await request(app.getHttpServer()).get(
      `/test/authorization/projects/${projectAId}`,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.code).toBe('AUTH_TOKEN_EXPIRED');

    const ordinaryAdminAccess = await request(app.getHttpServer())
      .get('/test/authorization/admin')
      .set('Authorization', `Bearer ${userAToken}`);
    expect(ordinaryAdminAccess.status).toBe(403);
    expect(ordinaryAdminAccess.body.code).toBe('FORBIDDEN');

    const adminAccess = await request(app.getHttpServer())
      .get('/test/authorization/admin')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminAccess.status).toBe(200);
    expect(adminAccess.body).toEqual({ allowed: true });

    await prisma.user.update({ where: { id: userAId }, data: { tokenVersion: { increment: 1 } } });
    const staleToken = await request(app.getHttpServer())
      .get(`/test/authorization/projects/${projectAId}`)
      .set('Authorization', `Bearer ${userAToken}`);
    expect(staleToken.status).toBe(401);
    expect(staleToken.body.code).toBe('AUTH_TOKEN_EXPIRED');
  });
});
