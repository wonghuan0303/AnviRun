import { validateFormSchema, type FormSchema, type FormSchemaIssue } from '@anvilrun/contracts';

export interface JsonSyntaxIssue {
  message: string;
  line?: number;
  column?: number;
}

export interface ParsedFormSchema {
  value: FormSchema | null;
  issues: readonly FormSchemaIssue[];
  syntaxIssue: JsonSyntaxIssue | null;
}

function syntaxLocation(text: string, error: unknown): { line?: number; column?: number } {
  if (!(error instanceof SyntaxError)) return {};
  const match = /position (\d+)/i.exec(error.message);
  if (!match) return {};
  const position = Number(match[1]);
  const before = text.slice(0, position);
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function parseFormSchemaText(text: string): ParsedFormSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      value: null,
      issues: [],
      syntaxIssue: {
        message: error instanceof Error ? error.message : 'JSON 语法错误',
        ...syntaxLocation(text, error),
      },
    };
  }
  const result = validateFormSchema(parsed);
  return result.ok
    ? { value: result.value, issues: [], syntaxIssue: null }
    : { value: null, issues: result.issues, syntaxIssue: null };
}

export function schemaText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '[]';
}

export function isFormSchemaIssues(value: unknown): value is FormSchemaIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (issue) =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof (issue as { message?: unknown }).message === 'string',
    )
  );
}
