import { describe, expect, it } from 'vitest';

import { parseFormSchemaText } from './schema';

describe('formSchema parser', () => {
  it('returns a validated schema and rejects unknown controls with a pointer', () => {
    const result = parseFormSchemaText(
      JSON.stringify([{ type: 'slider', name: 'amount', label: '金额' }]),
    );

    expect(result.value).toBeNull();
    expect(result.issues[0]).toMatchObject({
      code: 'FIELD_TYPE_UNKNOWN',
      pointer: '/0/type',
      fieldIndex: 0,
      property: 'type',
    });
  });

  it('reports JSON syntax line and column without clearing the source', () => {
    const result = parseFormSchemaText('[\n  {"type": "input",\n  }');

    expect(result.value).toBeNull();
    expect(result.syntaxIssue?.line).toBe(3);
    expect(result.syntaxIssue?.column).toBeGreaterThan(1);
  });

  it('accepts the shared whitelist and preserves default values', () => {
    const result = parseFormSchemaText(
      JSON.stringify([
        { type: 'input', name: 'branch', label: '分支', required: true, defaultValue: 'main' },
        {
          type: 'select',
          name: 'mode',
          label: '模式',
          options: [{ label: '快速', value: 'fast' }],
          defaultValue: 'fast',
        },
      ]),
    );

    expect(result.issues).toHaveLength(0);
    expect(result.value?.[0].name).toBe('branch');
  });
});
