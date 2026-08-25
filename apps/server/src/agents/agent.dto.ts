export interface CreateAgentDto {
  name: string;
}

export interface UpdateAgentDto {
  name: string;
}

export interface AgentListQuery {
  page: number;
  pageSize: number;
  search?: string;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('body must be an object');
  }
  return input as Record<string, unknown>;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function agentName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('name must be a string');
  const name = value.trim();
  if (name.length < 1 || name.length > 128 || hasControlCharacters(name)) {
    throw new Error('name is invalid');
  }
  return name;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new Error('unknown property');
}

export function parseCreateAgentDto(input: unknown): CreateAgentDto {
  const body = objectInput(input);
  onlyKeys(body, ['name']);
  return { name: agentName(body.name) };
}

export function parseUpdateAgentDto(input: unknown): UpdateAgentDto {
  const body = objectInput(input);
  onlyKeys(body, ['name']);
  return { name: agentName(body.name) };
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

export function parseAgentListQuery(
  pageValue: string | undefined,
  pageSizeValue: string | undefined,
  searchValue: string | undefined,
): AgentListQuery {
  const search = searchValue?.trim();
  if (search && (search.length > 128 || hasControlCharacters(search))) {
    throw new Error('search is invalid');
  }
  return {
    page: positiveInteger(pageValue, 1, 1_000_000),
    pageSize: positiveInteger(pageSizeValue, 20, 100),
    ...(search ? { search } : {}),
  };
}
