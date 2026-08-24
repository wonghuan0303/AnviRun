import { Prisma, PrismaClient, Project } from '@prisma/client';

export interface ProjectPageCursor {
  createdAt: Date;
  id: string;
}

export interface ProjectPage {
  items: Project[];
  hasNextPage: boolean;
  nextCursor: ProjectPageCursor | null;
}

/**
 * 按 createdAt/id 复合顺序分页，只返回未软删除的项目。
 * T1.3 的所有权 Guard 应在调用前提供 ownerId；本函数不实现权限判断。
 */
export async function listActiveProjectsPage(
  prisma: PrismaClient,
  input: { ownerId: string; limit: number; cursor?: ProjectPageCursor },
): Promise<ProjectPage> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error('project page limit must be an integer between 1 and 100');
  }

  const where: Prisma.ProjectWhereInput = {
    ownerId: input.ownerId,
    deletedAt: null,
  };

  if (input.cursor) {
    where.OR = [
      { createdAt: { gt: input.cursor.createdAt } },
      {
        createdAt: input.cursor.createdAt,
        id: { gt: input.cursor.id },
      },
    ];
  }

  const rows = await prisma.project.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: input.limit + 1,
  });
  const hasNextPage = rows.length > input.limit;
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);

  return {
    items,
    hasNextPage,
    nextCursor:
      hasNextPage && last
        ? {
            createdAt: last.createdAt,
            id: last.id,
          }
        : null,
  };
}
