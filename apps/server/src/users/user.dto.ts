import { UserRole, UserStatus } from '@prisma/client';
import { containsControlCharacters } from '@anvilrun/contracts';

export interface AdminUserListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string;
  readonly role?: UserRole;
  readonly status?: UserStatus;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('unknown property');
  }
}

function queryValue(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`query ${key} is invalid`);
  return value;
}

function positiveQueryInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error('pagination is invalid');

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error('pagination is invalid');
  }

  return parsed;
}

function optionalSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim();
  if (result.length === 0) return undefined;
  if (result.length > 128 || containsControlCharacters(result)) {
    throw new Error('search is invalid');
  }
  return result;
}

function optionalEnum<T extends string>(
  value: string | undefined,
  values: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const result = value.trim() as T;
  if (!values.includes(result)) throw new Error(`${field} is invalid`);
  return result;
}

export function parseAdminUserListQuery(input: Record<string, unknown>): AdminUserListQuery {
  onlyKeys(input, ['page', 'pageSize', 'search', 'role', 'status']);

  const search = optionalSearch(queryValue(input, 'search'));
  const role = optionalEnum(queryValue(input, 'role'), [UserRole.ADMIN, UserRole.USER], 'role');
  const status = optionalEnum(
    queryValue(input, 'status'),
    [UserStatus.ACTIVE, UserStatus.DISABLED],
    'status',
  );

  return {
    page: positiveQueryInteger(queryValue(input, 'page'), 1, 1_000_000),
    pageSize: positiveQueryInteger(queryValue(input, 'pageSize'), 10, 100),
    ...(search === undefined ? {} : { search }),
    ...(role === undefined ? {} : { role }),
    ...(status === undefined ? {} : { status }),
  };
}
