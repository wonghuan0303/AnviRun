import { describe, expect, it } from 'vitest';
import {
  analyzeFormConfigCompatibility,
  normalizeFormConfigValues,
  validateFormConfigValues,
  type FormSchema,
} from './index';

describe('form config values', () => {
  const schema: FormSchema = [
    {
      type: 'input',
      name: 'branch',
      label: 'Branch',
      required: true,
      defaultValue: 'main',
      minLength: 1,
      maxLength: 32,
    },
    {
      type: 'number',
      name: 'retries',
      label: 'Retries',
      defaultValue: 1,
      min: 0,
      max: 5,
      step: 1,
    },
    {
      type: 'select',
      name: 'mode',
      label: 'Mode',
      options: [
        { label: 'Fast', value: 'fast' },
        { label: 'Two', value: 2 },
      ],
    },
    {
      type: 'checkbox',
      name: 'targets',
      label: 'Targets',
      options: [
        { label: 'Web', value: 'web' },
        { label: 'Native', value: 2 },
      ],
    },
    { type: 'date', name: 'releaseDate', label: 'Release date' },
  ];

  it('filters unknown fields and applies defaults', () => {
    expect(normalizeFormConfigValues(schema, { mode: 'fast', extra: 'ignored' })).toEqual({
      branch: 'main',
      retries: 1,
      mode: 'fast',
    });
  });

  it('validates control values and constraints without echoing values', () => {
    const result = validateFormConfigValues(schema, {
      branch: '',
      retries: 1.5,
      mode: 'missing',
      targets: ['web', 'web'],
      releaseDate: '2026-02-30',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'FIELD_CONSTRAINT_INVALID',
      'FIELD_CONSTRAINT_INVALID',
      'FIELD_OPTION_NOT_ALLOWED',
      'FIELD_DUPLICATE_VALUE',
      'FIELD_DATE_INVALID',
    ]);
    expect(JSON.stringify(result.issues)).not.toContain('missing');
  });

  it('rejects required values and non-object/nested values', () => {
    const required = validateFormConfigValues(
      [{ type: 'input', name: 'required', label: 'Required', required: true }],
      {},
    );
    expect(required.ok).toBe(false);
    if (!required.ok) expect(required.issues[0]?.code).toBe('FIELD_REQUIRED');

    const arrayInput = validateFormConfigValues([], []);
    expect(arrayInput.ok).toBe(false);

    const nested = validateFormConfigValues([{ type: 'input', name: 'name', label: 'Name' }], {
      name: { nested: true },
    });
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.issues[0]?.code).toBe('FIELD_TYPE_INVALID');
  });

  it('reports compatibility changes deterministically', () => {
    const defaultAdded = analyzeFormConfigCompatibility(
      [
        { type: 'input', name: 'branch', label: 'Branch' },
        { type: 'input', name: 'newField', label: 'New', defaultValue: 'default' },
      ],
      { branch: 'main' },
    );
    expect(defaultAdded).toMatchObject({
      valid: true,
      effectiveConfig: { branch: 'main', newField: 'default' },
    });

    const requiredAdded = analyzeFormConfigCompatibility(
      [{ type: 'input', name: 'required', label: 'Required', required: true }],
      {},
    );
    expect(requiredAdded.valid).toBe(false);
    expect(requiredAdded.missingFields).toEqual(['required']);

    const obsolete = analyzeFormConfigCompatibility(
      [{ type: 'input', name: 'branch', label: 'Branch' }],
      { branch: 'main', removed: 'old' },
    );
    expect(obsolete).toMatchObject({
      valid: true,
      effectiveConfig: { branch: 'main' },
      obsoleteFields: ['removed'],
    });

    const typeConflict = analyzeFormConfigCompatibility(
      [{ type: 'number', name: 'branch', label: 'Branch' }],
      { branch: 'main' },
    );
    expect(typeConflict.typeConflictFields).toEqual(['branch']);

    const optionChanged = analyzeFormConfigCompatibility(
      [
        {
          type: 'select',
          name: 'mode',
          label: 'Mode',
          options: [{ label: 'New', value: 'new' }],
        },
      ],
      { mode: 'old' },
    );
    expect(optionChanged.valid).toBe(false);
    expect(optionChanged.issues[0]?.code).toBe('FIELD_OPTION_NOT_ALLOWED');
  });
});
