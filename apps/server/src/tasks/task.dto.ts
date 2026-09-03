import { parseBuildTaskStatus, type BuildTaskStatus } from '@anvilrun/contracts';

export interface TaskListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: BuildTaskStatus;
}

export interface TaskLogQuery {
  readonly offset: number;
  readonly limit: number;
}

export interface TaskCancelDto {
  readonly reason?: string;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('body must be an object');
  }
  return input as Record<string, unknown>;
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

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error('pagination is invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error('pagination is invalid');
  }
  return parsed;
}

export function parseCreateTaskDto(input: unknown): Record<never, never> {
  const body = objectInput(input);
  onlyKeys(body, []);
  return {};
}

export function parseCancelTaskDto(input: unknown): TaskCancelDto {
  const body = objectInput(input);
  onlyKeys(body, ['reason']);
  const reason = body.reason;
  if (reason === undefined) return {};
  if (typeof reason !== 'string') throw new Error('reason is invalid');
  const trimmed = reason.trim();
  if (
    trimmed.length > 1_024 ||
    Array.from(trimmed).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('reason is invalid');
  }
  return trimmed ? { reason: trimmed } : {};
}

export function parseTaskListQuery(input: Record<string, unknown>): TaskListQuery {
  onlyKeys(input, ['page', 'pageSize', 'status']);
  const rawStatus = queryValue(input, 'status');
  return {
    page: positiveInteger(queryValue(input, 'page'), 1, 1_000_000),
    pageSize: positiveInteger(queryValue(input, 'pageSize'), 20, 100),
    ...(rawStatus === undefined ? {} : { status: parseBuildTaskStatus(rawStatus) }),
  };
}

export function parseTaskLogQuery(input: Record<string, unknown>): TaskLogQuery {
  onlyKeys(input, ['offset', 'limit']);
  const offsetValue = queryValue(input, 'offset');
  const limitValue = queryValue(input, 'limit');
  const offset = offsetValue === undefined ? 0 : parseSafeInteger(offsetValue, false);
  const limit = limitValue === undefined ? 65_536 : parseSafeInteger(limitValue, true);
  if (limit > 1_048_576) throw new Error('log limit is invalid');
  return { offset, limit };
}

function parseSafeInteger(value: string, positive: boolean): number {
  if (!/^[0-9]+$/.test(value)) throw new Error('integer is invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive ? parsed < 1 : parsed < 0)) {
    throw new Error('integer is invalid');
  }
  return parsed;
}
