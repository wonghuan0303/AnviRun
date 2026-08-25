import { Prisma } from '@prisma/client';

/**
 * Lock a User row before touching that user's refresh-token set.
 *
 * T1.2 authentication mutations use this as their first row-level lock so
 * refresh rotation, password reset, and disable cannot pass each other with
 * different snapshots of the same user's sessions.
 */
export async function lockUserForUpdate(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "User" WHERE "id" = CAST(${userId} AS uuid) FOR UPDATE`,
  );
  return rows.length === 1;
}
