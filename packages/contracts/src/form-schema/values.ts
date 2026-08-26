/**
 * Project.config 使用的运行时值校验、规范化与模板兼容性分析。
 *
 * 该模块只处理 JSON 配置值，不执行任何业务副作用。未知字段会被过滤；
 * 因此 Server 与 Web 可以复用同一套确定性规则。
 */
import {
  ContractValidationError,
  createIssue,
  describeValueType,
  isBoolean,
  isCalendarDateString,
  isFiniteNumber,
  isString,
  type ValidationIssue,
  type ValidationPathSegment,
} from '../validation';
import type { FormField, FormFieldOptionValue, FormSchema } from './field-types';

export type FormFieldValue = string | number | boolean | readonly FormFieldOptionValue[] | null;

export type FormConfigValues = Readonly<Record<string, FormFieldValue>>;

export const FORM_CONFIG_ISSUE_CODES = [
  'CONFIG_NOT_OBJECT',
  'FIELD_REQUIRED',
  'FIELD_TYPE_INVALID',
  'FIELD_OPTION_NOT_ALLOWED',
  'FIELD_CONSTRAINT_INVALID',
  'FIELD_DATE_INVALID',
  'FIELD_DUPLICATE_VALUE',
] as const;

export type FormConfigIssueCode = (typeof FORM_CONFIG_ISSUE_CODES)[number];

export interface FormConfigIssue extends ValidationIssue<FormConfigIssueCode> {
  readonly fieldName?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface FormConfigValidationFailure {
  readonly ok: false;
  readonly issues: readonly FormConfigIssue[];
}

export type FormConfigValidationResult =
  { readonly ok: true; readonly value: FormConfigValues } | FormConfigValidationFailure;

export interface FormConfigCompatibility {
  readonly valid: boolean;
  readonly effectiveConfig: FormConfigValues;
  readonly missingFields: readonly string[];
  readonly obsoleteFields: readonly string[];
  readonly typeConflictFields: readonly string[];
  readonly issues: readonly FormConfigIssue[];
}

function isStrictJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function configIssue(
  code: FormConfigIssueCode,
  path: readonly ValidationPathSegment[],
  message: string,
  fieldName?: string,
  expected?: string,
  actual?: string,
): FormConfigIssue {
  return {
    ...createIssue(code, path, message),
    ...(fieldName === undefined ? {} : { fieldName }),
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

function isOptionValue(value: unknown): value is FormFieldOptionValue {
  return isString(value) || isFiniteNumber(value);
}

function sameOptionValue(left: FormFieldOptionValue, right: FormFieldOptionValue): boolean {
  return typeof left === typeof right && left === right;
}

function isAllowedOption(field: FormField, value: FormFieldOptionValue): boolean {
  if (!('options' in field)) {
    return false;
  }

  return field.options.some((option) => sameOptionValue(option.value, value));
}

function expectedFieldType(field: FormField): string {
  switch (field.type) {
    case 'input':
    case 'textarea':
    case 'password':
    case 'date':
      return 'string';
    case 'number':
      return 'finite number';
    case 'select':
    case 'radio':
      return 'string or finite number in options';
    case 'checkbox':
      return 'array of string or finite number option values';
    case 'switch':
      return 'boolean';
  }
}

function valueIssue(
  field: FormField,
  code: FormConfigIssueCode,
  message: string,
  expected: string,
  actual: unknown,
  path: readonly ValidationPathSegment[] = [field.name],
): FormConfigIssue {
  return configIssue(code, path, message, field.name, expected, describeValueType(actual));
}

function validateTextValue(
  field: FormField,
  value: unknown,
): {
  value?: string;
  issues: FormConfigIssue[];
} {
  if (!isString(value)) {
    return {
      issues: [
        valueIssue(
          field,
          'FIELD_TYPE_INVALID',
          `字段 ${field.name} 的值类型不符合模板`,
          expectedFieldType(field),
          value,
        ),
      ],
    };
  }

  const issues: FormConfigIssue[] = [];
  const minLength = 'minLength' in field ? field.minLength : undefined;
  const maxLength = 'maxLength' in field ? field.maxLength : undefined;

  if (minLength !== undefined && value.length < minLength) {
    issues.push(
      valueIssue(
        field,
        'FIELD_CONSTRAINT_INVALID',
        `字段 ${field.name} 的长度小于模板要求`,
        `length >= ${minLength}`,
        value,
      ),
    );
  }

  if (maxLength !== undefined && value.length > maxLength) {
    issues.push(
      valueIssue(
        field,
        'FIELD_CONSTRAINT_INVALID',
        `字段 ${field.name} 的长度超过模板限制`,
        `length <= ${maxLength}`,
        value,
      ),
    );
  }

  if ('pattern' in field && field.pattern !== undefined) {
    let matches = false;

    try {
      matches = new RegExp(field.pattern).test(value);
    } catch {
      matches = false;
    }

    if (!matches) {
      issues.push(
        valueIssue(
          field,
          'FIELD_CONSTRAINT_INVALID',
          `字段 ${field.name} 不匹配模板正则约束`,
          'pattern',
          value,
        ),
      );
    }
  }

  return issues.length === 0 ? { value, issues } : { issues };
}

function validateNumberValue(
  field: Extract<FormField, { type: 'number' }>,
  value: unknown,
): {
  value?: number;
  issues: FormConfigIssue[];
} {
  if (!isFiniteNumber(value)) {
    return {
      issues: [
        valueIssue(
          field,
          'FIELD_TYPE_INVALID',
          `字段 ${field.name} 的值类型不符合模板`,
          expectedFieldType(field),
          value,
        ),
      ],
    };
  }

  const issues: FormConfigIssue[] = [];
  if (field.min !== undefined && value < field.min) {
    issues.push(
      valueIssue(
        field,
        'FIELD_CONSTRAINT_INVALID',
        `字段 ${field.name} 小于模板最小值`,
        `value >= ${field.min}`,
        value,
      ),
    );
  }

  if (field.max !== undefined && value > field.max) {
    issues.push(
      valueIssue(
        field,
        'FIELD_CONSTRAINT_INVALID',
        `字段 ${field.name} 大于模板最大值`,
        `value <= ${field.max}`,
        value,
      ),
    );
  }

  if (field.step !== undefined) {
    const base = field.min ?? 0;
    const quotient = (value - base) / field.step;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      issues.push(
        valueIssue(
          field,
          'FIELD_CONSTRAINT_INVALID',
          `字段 ${field.name} 不符合模板步长`,
          `step=${field.step}`,
          value,
        ),
      );
    }
  }

  return issues.length === 0 ? { value, issues } : { issues };
}

function validateOptionValue(
  field: FormField,
  value: unknown,
): {
  value?: FormFieldOptionValue;
  issues: FormConfigIssue[];
} {
  if (!isOptionValue(value)) {
    return {
      issues: [
        valueIssue(
          field,
          'FIELD_TYPE_INVALID',
          `字段 ${field.name} 的值类型不符合模板`,
          expectedFieldType(field),
          value,
        ),
      ],
    };
  }

  if (!isAllowedOption(field, value)) {
    return {
      issues: [
        valueIssue(
          field,
          'FIELD_OPTION_NOT_ALLOWED',
          `字段 ${field.name} 的值不在模板 options 中`,
          'declared option value',
          value,
        ),
      ],
    };
  }

  return { value, issues: [] };
}

function validateCheckboxValue(
  field: FormField,
  value: unknown,
): {
  value?: readonly FormFieldOptionValue[];
  issues: FormConfigIssue[];
} {
  if (!Array.isArray(value)) {
    return {
      issues: [
        valueIssue(
          field,
          'FIELD_TYPE_INVALID',
          `字段 ${field.name} 的值类型不符合模板`,
          expectedFieldType(field),
          value,
        ),
      ],
    };
  }

  const issues: FormConfigIssue[] = [];
  const values: FormFieldOptionValue[] = [];

  value.forEach((item, index) => {
    if (!isOptionValue(item)) {
      issues.push(
        valueIssue(
          field,
          'FIELD_TYPE_INVALID',
          `字段 ${field.name} 的选中值类型不符合模板`,
          'string or finite number',
          item,
          [field.name, index],
        ),
      );
      return;
    }

    if (values.some((existing) => sameOptionValue(existing, item))) {
      issues.push(
        valueIssue(
          field,
          'FIELD_DUPLICATE_VALUE',
          `字段 ${field.name} 不能包含重复选项`,
          'unique option values',
          value,
          [field.name, index],
        ),
      );
      return;
    }

    if (!isAllowedOption(field, item)) {
      issues.push(
        valueIssue(
          field,
          'FIELD_OPTION_NOT_ALLOWED',
          `字段 ${field.name} 的选中值不在模板 options 中`,
          'declared option value',
          item,
          [field.name, index],
        ),
      );
      return;
    }

    values.push(item);
  });

  return issues.length === 0 ? { value: values, issues } : { issues };
}

function validateFieldValue(
  field: FormField,
  value: unknown,
): {
  value?: FormFieldValue;
  issues: FormConfigIssue[];
} {
  switch (field.type) {
    case 'input':
    case 'textarea':
    case 'password':
      return validateTextValue(field, value);
    case 'number':
      return validateNumberValue(field, value);
    case 'select':
    case 'radio':
      return validateOptionValue(field, value);
    case 'checkbox':
      return validateCheckboxValue(field, value);
    case 'switch':
      return isBoolean(value)
        ? { value, issues: [] }
        : {
            issues: [
              valueIssue(
                field,
                'FIELD_TYPE_INVALID',
                `字段 ${field.name} 的值类型不符合模板`,
                expectedFieldType(field),
                value,
              ),
            ],
          };
    case 'date':
      return isCalendarDateString(value)
        ? { value, issues: [] }
        : {
            issues: [
              valueIssue(
                field,
                'FIELD_DATE_INVALID',
                `字段 ${field.name} 必须是合法的 YYYY-MM-DD 日期`,
                'YYYY-MM-DD calendar date',
                value,
              ),
            ],
          };
  }
}

interface Evaluation {
  readonly value: Record<string, FormFieldValue>;
  readonly issues: FormConfigIssue[];
}

function evaluateConfig(schema: FormSchema, input: unknown): Evaluation {
  if (!isStrictJsonObject(input)) {
    return {
      value: {},
      issues: [
        configIssue(
          'CONFIG_NOT_OBJECT',
          [],
          '项目配置必须是普通 JSON 对象',
          undefined,
          'object',
          describeValueType(input),
        ),
      ],
    };
  }

  const result: Record<string, FormFieldValue> = {};
  const issues: FormConfigIssue[] = [];

  for (const field of schema) {
    const hasInput = hasOwn(input, field.name);
    const hasDefault = Object.prototype.hasOwnProperty.call(field, 'defaultValue');
    const candidate = field.disabled
      ? hasDefault
        ? field.defaultValue
        : undefined
      : hasInput
        ? input[field.name]
        : hasDefault
          ? field.defaultValue
          : undefined;

    if (candidate === undefined || candidate === null) {
      if (field.required) {
        issues.push(
          configIssue(
            'FIELD_REQUIRED',
            [field.name],
            `必填字段 ${field.name} 未提供值`,
            field.name,
            expectedFieldType(field),
            candidate === null ? 'null' : 'undefined',
          ),
        );
      }
      continue;
    }

    const checked = validateFieldValue(field, candidate);
    issues.push(...checked.issues);
    if (checked.issues.length === 0 && checked.value !== undefined) {
      result[field.name] = checked.value;
    }
  }

  return { value: result, issues };
}

export function validateFormConfigValues(
  schema: FormSchema,
  input: unknown,
): FormConfigValidationResult {
  const evaluated = evaluateConfig(schema, input);
  return evaluated.issues.length === 0
    ? { ok: true, value: evaluated.value }
    : { ok: false, issues: evaluated.issues };
}

export function normalizeFormConfigValues(schema: FormSchema, input: unknown): FormConfigValues {
  const result = validateFormConfigValues(schema, input);
  if (!result.ok) {
    throw new ContractValidationError('项目配置校验失败', result.issues);
  }

  return result.value;
}

export function analyzeFormConfigCompatibility(
  schema: FormSchema,
  storedConfig: unknown,
): FormConfigCompatibility {
  const obsoleteFields = isStrictJsonObject(storedConfig)
    ? Object.keys(storedConfig).filter((key) => !schema.some((field) => field.name === key))
    : [];

  const evaluated = evaluateConfig(schema, storedConfig);
  const missingFields = Array.from(
    new Set(
      evaluated.issues
        .filter((issue) => issue.code === 'FIELD_REQUIRED' && issue.fieldName !== undefined)
        .map((issue) => issue.fieldName as string),
    ),
  );
  const typeConflictFields = Array.from(
    new Set(
      evaluated.issues
        .filter((issue) => issue.code === 'FIELD_TYPE_INVALID' && issue.fieldName !== undefined)
        .map((issue) => issue.fieldName as string),
    ),
  );

  return {
    valid: evaluated.issues.length === 0,
    effectiveConfig: evaluated.value,
    missingFields,
    obsoleteFields,
    typeConflictFields,
    issues: evaluated.issues,
  };
}
