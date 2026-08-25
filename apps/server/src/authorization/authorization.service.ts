import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';

import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../database/prisma.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Centralized resource authorization for all future Project-owned APIs.
 *
 * Project.ownerId is the only ownership source. Task, task-log, and Artifact
 * access always traverse the live Project relation; createdBy, Agent, and
 * storagePath are deliberately not part of these scopes.
 */
@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  projectScope(
    actor: AuthenticatedRequestUser,
    additional: Prisma.ProjectWhereInput = {},
  ): Prisma.ProjectWhereInput {
    return {
      AND: [this.activeProjectScope(actor), additional],
    };
  }

  taskScope(
    actor: AuthenticatedRequestUser,
    additional: Prisma.BuildTaskWhereInput = {},
  ): Prisma.BuildTaskWhereInput {
    return {
      AND: [{ project: { is: this.activeProjectScope(actor) } }, additional],
    };
  }

  artifactScope(
    actor: AuthenticatedRequestUser,
    additional: Prisma.ArtifactWhereInput = {},
  ): Prisma.ArtifactWhereInput {
    return {
      AND: [
        { deletedAt: null },
        {
          task: {
            is: {
              project: { is: this.activeProjectScope(actor) },
            },
          },
        },
        additional,
      ],
    };
  }

  async assertProjectAccess(
    actor: AuthenticatedRequestUser,
    projectId: string,
  ): Promise<Awaited<ReturnType<PrismaService['project']['findFirst']>>> {
    this.assertUuid(projectId);
    const project = await this.prisma.project.findFirst({
      where: this.projectScope(actor, { id: projectId }),
    });
    if (!project) throw new ApiException('RESOURCE_NOT_FOUND');
    return project;
  }

  async assertTaskAccess(
    actor: AuthenticatedRequestUser,
    taskId: string,
  ): Promise<Awaited<ReturnType<PrismaService['buildTask']['findFirst']>>> {
    this.assertUuid(taskId);
    const task = await this.prisma.buildTask.findFirst({
      where: this.taskScope(actor, { id: taskId }),
    });
    if (!task) throw new ApiException('RESOURCE_NOT_FOUND');
    return task;
  }

  async assertTaskLogAccess(
    actor: AuthenticatedRequestUser,
    taskId: string,
  ): Promise<Awaited<ReturnType<PrismaService['buildTask']['findFirst']>>> {
    return this.assertTaskAccess(actor, taskId);
  }

  async assertArtifactAccess(
    actor: AuthenticatedRequestUser,
    artifactId: string,
  ): Promise<Awaited<ReturnType<PrismaService['artifact']['findFirst']>>> {
    this.assertUuid(artifactId);
    const artifact = await this.prisma.artifact.findFirst({
      where: this.artifactScope(actor, { id: artifactId }),
    });
    if (!artifact) throw new ApiException('RESOURCE_NOT_FOUND');
    return artifact;
  }

  private activeProjectScope(actor: AuthenticatedRequestUser): Prisma.ProjectWhereInput {
    return {
      deletedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { ownerId: actor.id }),
    };
  }

  private assertUuid(value: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new ApiException('RESOURCE_NOT_FOUND');
    }
  }
}
