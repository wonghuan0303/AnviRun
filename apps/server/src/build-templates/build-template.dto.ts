import {
  validateFormSchema,
  type FormSchema,
  type FormSchemaIssue,
} from '@buildplatform/contracts';

export interface CreateBuildTemplateInput {
  name: string;
  description: string | null;
  agentId: string;
  gitUrl: string;
  command: string;
  artifactDir: string;
  formSchema: FormSchema;
  timeoutSeconds: number;
}

export interface UpdateBuildTemplateInput {
  name?: string;
  description?: string | null;
  agentId?: string;
  gitUrl?: string;
  command?: string;
  artifactDir?: string;
  formSchema?: FormSchema;
  timeoutSeconds?: number;
}

export interface BuildTemplateListQuery {
  page: number;
  pageSize: number;
  enabled?: boolean;
  agentId?: string;
  search?: string;
}

export interface PublicBuildTemplateListQuery {
  page: number;
  pageSize: number;
}

export class FormSchemaValidationError extends Error {
  constructor(readonly issues: readonly FormSchemaIssue[]) {
    super('formSchema validation failed');
    this.name = 'FormSchemaValidationError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TIMEOUT_SECONDS = 86_400;

function objectInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('body must be an object');
  }
  return input as Record<string, unknown>;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error('unknown property');
  }
}

function hasControlCharacters(value: string, allowWhitespaceControls = false): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    if (allowWhitespaceControls && (code === 9 || code === 10 || code === 13)) return false;
    return code < 32 || code === 127;
  });
}

function requiredText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (result.length < 1 || result.length > maximum || hasControlCharacters(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function optionalDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('description must be a string or null');
  const result = value.trim();
  if (result.length > 4_096 || hasControlCharacters(result, true)) {
    throw new Error('description is invalid');
  }
  return result.length === 0 ? null : result;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a UUID`);
  const result = value.trim();
  if (!UUID_PATTERN.test(result)) throw new Error(`${field} must be a UUID`);
  return result;
}

function gitUrl(value: unknown): string {
  const result = requiredText(value, 2_048, 'gitUrl');

  try {
    const parsed = new URL(result);
    const validPath = parsed.pathname.length > 1 && parsed.pathname !== '/';
    const noQueryOrFragment = parsed.search === '' && parsed.hash === '';

    if (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === '' &&
      validPath &&
      noQueryOrFragment
    ) {
      return result;
    }

    if (
      parsed.protocol === 'ssh:' &&
      parsed.hostname.length > 0 &&
      parsed.username === 'git' &&
      parsed.password === '' &&
      validPath &&
      noQueryOrFragment
    ) {
      return result;
    }
  } catch {
    // The SCP-style form below is not accepted by the URL parser.
  }

  if (/^git@[A-Za-z0-9][A-Za-z0-9.-]*:[^/\s][^\s]*$/.test(result)) return result;

  throw new Error('gitUrl is invalid');
}

function command(value: unknown): string {
  return requiredText(value, 8_192, 'command');
}

function artifactDirectory(value: unknown): string {
  if (typeof value !== 'string') throw new Error('artifactDir must be a string');
  const input = value.trim();
  if (input.length < 1 || input.length > 1_024 || hasControlCharacters(input)) {
    throw new Error('artifactDir is invalid');
  }

  const slashPath = input.replaceAll('\\', '/');
  if (slashPath.startsWith('/') || /^[A-Za-z]:/.test(slashPath) || slashPath.includes(':')) {
    throw new Error('artifactDir must be relative');
  }

  const segments = slashPath.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error('artifactDir contains a forbidden path segment');
  }

  const normalized = segments.filter((segment) => segment !== '.').join('/');
  if (normalized.length === 0) throw new Error('artifactDir is invalid');
  return normalized;
}

function formSchema(value: unknown): FormSchema {
  const result = validateFormSchema(value);
  if (!result.ok) throw new FormSchemaValidationError(result.issues);
  return result.value;
}

function timeoutSeconds(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('timeoutSeconds must be a positive integer');
  }
  if (value < 1 || value > MAX_TIMEOUT_SECONDS) {
    throw new Error('timeoutSeconds is out of range');
  }
  return value;
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

function parseSearch(value: string | undefined): string | undefined {
  const result = value?.trim();
  if (result && (result.length > 128 || hasControlCharacters(result))) {
    throw new Error('search is invalid');
  }
  return result || undefined;
}

export function parseCreateBuildTemplateDto(input: unknown): CreateBuildTemplateInput {
  const body = objectInput(input);
  onlyKeys(body, [
    'name',
    'description',
    'agentId',
    'gitUrl',
    'command',
    'artifactDir',
    'formSchema',
    'timeoutSeconds',
  ]);
  if (!hasOwn(body, 'formSchema')) throw new Error('formSchema is required');

  return {
    name: requiredText(body.name, 128, 'name'),
    description: optionalDescription(body.description),
    agentId: uuid(body.agentId, 'agentId'),
    gitUrl: gitUrl(body.gitUrl),
    command: command(body.command),
    artifactDir: artifactDirectory(body.artifactDir),
    formSchema: formSchema(body.formSchema),
    timeoutSeconds: timeoutSeconds(body.timeoutSeconds, 3_600),
  };
}

export function parseUpdateBuildTemplateDto(input: unknown): UpdateBuildTemplateInput {
  const body = objectInput(input);
  onlyKeys(body, [
    'name',
    'description',
    'agentId',
    'gitUrl',
    'command',
    'artifactDir',
    'formSchema',
    'timeoutSeconds',
  ]);
  if (Object.keys(body).length === 0) throw new Error('at least one property is required');

  return {
    ...(hasOwn(body, 'name') ? { name: requiredText(body.name, 128, 'name') } : {}),
    ...(hasOwn(body, 'description') ? { description: optionalDescription(body.description) } : {}),
    ...(hasOwn(body, 'agentId') ? { agentId: uuid(body.agentId, 'agentId') } : {}),
    ...(hasOwn(body, 'gitUrl') ? { gitUrl: gitUrl(body.gitUrl) } : {}),
    ...(hasOwn(body, 'command') ? { command: command(body.command) } : {}),
    ...(hasOwn(body, 'artifactDir') ? { artifactDir: artifactDirectory(body.artifactDir) } : {}),
    ...(hasOwn(body, 'formSchema') ? { formSchema: formSchema(body.formSchema) } : {}),
    ...(hasOwn(body, 'timeoutSeconds')
      ? { timeoutSeconds: timeoutSeconds(body.timeoutSeconds) }
      : {}),
  };
}

export function parseBuildTemplateListQuery(
  input: Record<string, unknown>,
): BuildTemplateListQuery {
  onlyKeys(input, ['page', 'pageSize', 'enabled', 'agentId', 'search']);
  const enabledValue = queryValue(input, 'enabled');
  let enabled: boolean | undefined;
  if (enabledValue !== undefined) {
    if (enabledValue !== 'true' && enabledValue !== 'false') {
      throw new Error('enabled is invalid');
    }
    enabled = enabledValue === 'true';
  }

  const agentIdValue = queryValue(input, 'agentId');
  return {
    page: positiveQueryInteger(queryValue(input, 'page'), 1, 1_000_000),
    pageSize: positiveQueryInteger(queryValue(input, 'pageSize'), 20, 100),
    ...(enabled === undefined ? {} : { enabled }),
    ...(agentIdValue === undefined ? {} : { agentId: uuid(agentIdValue, 'agentId') }),
    ...(parseSearch(queryValue(input, 'search')) === undefined
      ? {}
      : { search: parseSearch(queryValue(input, 'search')) }),
  };
}

export function parsePublicBuildTemplateListQuery(
  input: Record<string, unknown>,
): PublicBuildTemplateListQuery {
  onlyKeys(input, ['page', 'pageSize']);
  return {
    page: positiveQueryInteger(queryValue(input, 'page'), 1, 1_000_000),
    pageSize: positiveQueryInteger(queryValue(input, 'pageSize'), 20, 100),
  };
}
