import { containsControlCharacters } from '@anvilrun/contracts';

export interface CreateProjectInput {
  readonly name: string;
  readonly description: string | null;
  readonly buildTemplateId: string;
  readonly branch: string;
  readonly config: unknown;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly branch?: string;
}

export interface ProjectConfigInput {
  readonly config: unknown;
}

export interface ProjectListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string;
  readonly buildTemplateId?: string;
  readonly ownerId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('body must be an object');
  }

  return input as Record<string, unknown>;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('unknown property');
  }
}

function hasForbiddenControlCharacters(value: string, allowLineBreaks = false): boolean {
  if (!allowLineBreaks) return containsControlCharacters(value);

  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) return false;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function requiredText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (
    characterLength(result) < 1 ||
    characterLength(result) > maximum ||
    hasForbiddenControlCharacters(result)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function optionalDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('description must be a string or null');

  const result = value.trim();
  if (characterLength(result) > 4_096 || hasForbiddenControlCharacters(result, true)) {
    throw new Error('description is invalid');
  }

  return result.length === 0 ? null : result;
}

function branch(value: unknown): string {
  return requiredText(value, 512, 'branch');
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a UUID`);
  const result = value.trim();
  if (!UUID_PATTERN.test(result)) throw new Error(`${field} must be a UUID`);
  return result;
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
  if (result.length > 128 || hasForbiddenControlCharacters(result)) {
    throw new Error('search is invalid');
  }
  return result;
}

export function parseCreateProjectDto(input: unknown): CreateProjectInput {
  const body = objectInput(input);
  onlyKeys(body, ['name', 'description', 'buildTemplateId', 'branch', 'config']);
  if (!hasOwn(body, 'config')) throw new Error('config is required');

  return {
    name: requiredText(body.name, 128, 'name'),
    description: optionalDescription(body.description),
    buildTemplateId: uuid(body.buildTemplateId, 'buildTemplateId'),
    branch: branch(body.branch),
    config: body.config,
  };
}

export function parseUpdateProjectDto(input: unknown): UpdateProjectInput {
  const body = objectInput(input);
  onlyKeys(body, ['name', 'description', 'branch']);
  if (Object.keys(body).length === 0) throw new Error('at least one property is required');

  return {
    ...(hasOwn(body, 'name') ? { name: requiredText(body.name, 128, 'name') } : {}),
    ...(hasOwn(body, 'description') ? { description: optionalDescription(body.description) } : {}),
    ...(hasOwn(body, 'branch') ? { branch: branch(body.branch) } : {}),
  };
}

export function parseProjectConfigDto(input: unknown): ProjectConfigInput {
  const body = objectInput(input);
  onlyKeys(body, ['config']);
  if (!hasOwn(body, 'config')) throw new Error('config is required');
  return { config: body.config };
}

export function parseProjectListQuery(input: Record<string, unknown>): ProjectListQuery {
  onlyKeys(input, ['page', 'pageSize', 'search', 'buildTemplateId', 'ownerId']);

  const search = optionalSearch(queryValue(input, 'search'));
  const buildTemplateId = queryValue(input, 'buildTemplateId');
  const ownerId = queryValue(input, 'ownerId');

  return {
    page: positiveQueryInteger(queryValue(input, 'page'), 1, 1_000_000),
    pageSize: positiveQueryInteger(queryValue(input, 'pageSize'), 20, 100),
    ...(search === undefined ? {} : { search }),
    ...(buildTemplateId === undefined
      ? {}
      : { buildTemplateId: uuid(buildTemplateId, 'buildTemplateId') }),
    ...(ownerId === undefined ? {} : { ownerId: uuid(ownerId, 'ownerId') }),
  };
}
