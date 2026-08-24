/**
 * 配置表单模板运行时校验器。
 *
 * Server 与 Web 共用本文件：管理员上传模板时校验（实施计划 T3.1、T3.2），
 * 用户保存项目配置时用同一份模板做二次校验（T3.3、T3.4）。
 *
 * 校验策略：
 * - **收集全部问题**而不是首错即返回，便于管理端一次性展示所有错误；
 * - 问题顺序稳定（先按字段下标，再按“类型 → name → label → 公共属性 → 未知属性 →
 *   约束 → options → defaultValue”的顺序），因此可以直接快照测试；
 * - 未知属性一律拒绝，从而挡掉任意组件名、事件、插槽与未批准属性；
 * - 错误信息只描述值的类型与长度，不回显值本身，避免默认口令泄漏到日志。
 */

import { ContractValidationError, type ValidationSuccess } from '../validation/issue';
import { isMemberOf } from '../validation/enum';
import {
  describeToken,
  describeValueType,
  findUnknownProperties,
  isBoolean,
  isCalendarDateString,
  isFiniteNumber,
  isNonEmptyPlainText,
  isPlainObject,
  isPlainText,
  isString,
} from '../validation/primitives';
import {
  FORM_FIELD_ALLOWED_PROPERTIES,
  FORM_FIELD_NAME_MAX_LENGTH,
  FORM_FIELD_NAME_PATTERN,
  FORM_FIELD_PATTERN_MAX_LENGTH,
  FORM_FIELD_TYPES,
  type FormField,
  type FormFieldOptionValue,
  type FormFieldType,
  type FormSchema,
} from './field-types';
import { createFormSchemaIssue, type FormSchemaIssue, type FormSchemaIssueContext } from './issues';

/** 校验失败结果。`issues` 至少一条，顺序稳定。 */
export interface FormSchemaValidationFailure {
  readonly ok: false;
  readonly issues: readonly FormSchemaIssue[];
}

/** 表单模板校验结果。 */
export type FormSchemaValidationResult =
  ValidationSuccess<FormSchema> | FormSchemaValidationFailure;

/** 单个选项允许出现的属性。 */
const FORM_FIELD_OPTION_ALLOWED_PROPERTIES = ['label', 'value'] as const;

/** 可选布尔属性。 */
const OPTIONAL_BOOLEAN_PROPERTIES = ['required', 'disabled', 'sensitive'] as const;

/** 可选纯文本属性。允许空串（例如不需要提示时显式写 `placeholder: ''`）。 */
const OPTIONAL_TEXT_PROPERTIES = ['placeholder', 'description'] as const;

/** 字段级校验过程中解析出的约束，供 `defaultValue` 复用。 */
interface FieldConstraints {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  /** `options` 全部合法时为去重后的取值列表；存在问题时为 `undefined`。 */
  readonly optionValues?: readonly FormFieldOptionValue[];
}

/**
 * 校验配置表单模板。
 *
 * 成功时返回**规范化**后的模板：`password` 字段缺省的 `sensitive` 会补全为 `true`，
 * 其余属性保持原样（不填充 `required` / `disabled` 默认值，避免改变持久化内容）。
 */
export function validateFormSchema(input: unknown): FormSchemaValidationResult {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      issues: [
        createFormSchemaIssue(
          'SCHEMA_NOT_ARRAY',
          [],
          `模板顶层必须是数组，实际收到 ${describeValueType(input)}`,
        ),
      ],
    };
  }

  const fields: readonly unknown[] = input;
  const issues: FormSchemaIssue[] = [];
  const seenNames = new Map<string, number>();

  fields.forEach((field, index) => {
    validateField(field, index, seenNames, issues);
  });

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: (fields as readonly FormField[]).map(normalizeField) };
}

/** 判断输入是否为合法配置表单模板。 */
export function isFormSchema(input: unknown): input is FormSchema {
  return validateFormSchema(input).ok;
}

/**
 * 校验并返回规范化后的配置表单模板。
 *
 * @throws {ContractValidationError} 模板非法，`error.issues` 为完整问题列表。
 */
export function parseFormSchema(input: unknown): FormSchema {
  const result = validateFormSchema(input);

  if (result.ok) {
    return result.value;
  }

  throw new ContractValidationError('配置表单模板校验失败', result.issues);
}

/**
 * 判断字段是否敏感。
 *
 * `password` 在未显式声明时按敏感处理；校验器已拒绝 `password` 上的 `sensitive: false`，
 * 因此规范化后的模板中该函数与 `field.sensitive` 一致。
 */
export function isSensitiveFormField(field: FormField): boolean {
  return field.sensitive ?? field.type === 'password';
}

/**
 * 列出模板中全部敏感字段的 `name`，顺序与模板一致。
 *
 * Server 派发任务时把该列表放入 `task.assignment.sensitiveConfigKeys`，
 * Agent 据此遮蔽日志中的敏感值（产品设计第 11 节）。
 */
export function listSensitiveFormFieldNames(schema: FormSchema): readonly string[] {
  return schema.filter((field) => isSensitiveFormField(field)).map((field) => field.name);
}

function normalizeField(field: FormField): FormField {
  if (field.type === 'password' && field.sensitive === undefined) {
    return { ...field, sensitive: true };
  }

  return field;
}

function validateField(
  field: unknown,
  index: number,
  seenNames: Map<string, number>,
  issues: FormSchemaIssue[],
): void {
  if (!isPlainObject(field)) {
    issues.push(
      createFormSchemaIssue(
        'FIELD_NOT_OBJECT',
        [index],
        `字段必须是对象，实际收到 ${describeValueType(field)}`,
        { fieldIndex: index },
      ),
    );

    return;
  }

  const type = validateFieldType(field, index, issues);
  const name = validateFieldName(field, index, seenNames, issues);
  const context: FormSchemaIssueContext = { fieldIndex: index, fieldName: name };

  validateFieldLabel(field, index, context, issues);
  validateCommonOptionalProperties(field, index, context, issues);

  if (type === undefined) {
    return;
  }

  validateUnknownProperties(field, type, index, context, issues);

  const constraints = validateConstraints(field, type, index, context, issues);

  validateDefaultValue(field, type, index, context, constraints, issues);
}

function validateFieldType(
  field: Record<string, unknown>,
  index: number,
  issues: FormSchemaIssue[],
): FormFieldType | undefined {
  const raw = field.type;
  const context: FormSchemaIssueContext = { fieldIndex: index, property: 'type' };

  if (raw === undefined) {
    issues.push(createFormSchemaIssue('FIELD_TYPE_MISSING', [index, 'type'], '缺少 type', context));

    return undefined;
  }

  if (!isMemberOf(FORM_FIELD_TYPES, raw)) {
    issues.push(
      createFormSchemaIssue(
        'FIELD_TYPE_UNKNOWN',
        [index, 'type'],
        `type 必须属于 [${FORM_FIELD_TYPES.join(', ')}]，实际收到 ${describeToken(raw)}`,
        context,
      ),
    );

    return undefined;
  }

  return raw;
}

function validateFieldName(
  field: Record<string, unknown>,
  index: number,
  seenNames: Map<string, number>,
  issues: FormSchemaIssue[],
): string | undefined {
  const raw = field.name;
  const context: FormSchemaIssueContext = { fieldIndex: index, property: 'name' };

  if (!isString(raw)) {
    issues.push(
      createFormSchemaIssue(
        'FIELD_NAME_MISSING',
        [index, 'name'],
        `缺少 name 或 name 不是字符串，实际收到 ${describeValueType(raw)}`,
        context,
      ),
    );

    return undefined;
  }

  if (!FORM_FIELD_NAME_PATTERN.test(raw)) {
    issues.push(
      createFormSchemaIssue(
        'FIELD_NAME_INVALID',
        [index, 'name'],
        `name 必须匹配 ${FORM_FIELD_NAME_PATTERN.source}` +
          `（长度 1–${FORM_FIELD_NAME_MAX_LENGTH}），实际收到 ${describeToken(raw)}`,
        context,
      ),
    );

    return undefined;
  }

  const firstIndex = seenNames.get(raw);

  if (firstIndex !== undefined) {
    issues.push(
      createFormSchemaIssue(
        'FIELD_NAME_DUPLICATE',
        [index, 'name'],
        `name ${describeToken(raw)} 与下标 ${firstIndex} 的字段重复，同一模板内必须唯一`,
        { ...context, fieldName: raw },
      ),
    );

    return raw;
  }

  seenNames.set(raw, index);

  return raw;
}

function validateFieldLabel(
  field: Record<string, unknown>,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): void {
  const raw = field.label;
  const labelContext: FormSchemaIssueContext = { ...context, property: 'label' };

  if (!isString(raw)) {
    issues.push(
      createFormSchemaIssue(
        'FIELD_LABEL_MISSING',
        [index, 'label'],
        `缺少 label 或 label 不是字符串，实际收到 ${describeValueType(raw)}`,
        labelContext,
      ),
    );

    return;
  }

  if (!isNonEmptyPlainText(raw)) {
    issues.push(
      createFormSchemaIssue(
        'FIELD_LABEL_INVALID',
        [index, 'label'],
        'label 必须是非空纯文本，不允许空白串、控制字符或 HTML/XML 标签',
        labelContext,
      ),
    );
  }
}

function validateCommonOptionalProperties(
  field: Record<string, unknown>,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): void {
  for (const property of OPTIONAL_BOOLEAN_PROPERTIES) {
    const raw = field[property];

    if (raw !== undefined && !isBoolean(raw)) {
      issues.push(
        createFormSchemaIssue(
          'PROPERTY_TYPE_INVALID',
          [index, property],
          `${property} 必须是布尔值，实际收到 ${describeValueType(raw)}`,
          { ...context, property },
        ),
      );
    }
  }

  for (const property of OPTIONAL_TEXT_PROPERTIES) {
    const raw = field[property];

    if (raw !== undefined && !isPlainText(raw)) {
      issues.push(
        createFormSchemaIssue(
          'PROPERTY_TYPE_INVALID',
          [index, property],
          `${property} 必须是纯文本字符串，不允许控制字符或 HTML/XML 标签`,
          { ...context, property },
        ),
      );
    }
  }
}

function validateUnknownProperties(
  field: Record<string, unknown>,
  type: FormFieldType,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): void {
  const allowed = FORM_FIELD_ALLOWED_PROPERTIES[type];

  for (const property of findUnknownProperties(field, allowed)) {
    issues.push(
      createFormSchemaIssue(
        'UNKNOWN_PROPERTY',
        [index, property],
        `控件 ${type} 不允许属性 ${describeToken(property)}；` +
          `允许的属性为 [${allowed.join(', ')}]`,
        { ...context, property },
      ),
    );
  }
}

function validateConstraints(
  field: Record<string, unknown>,
  type: FormFieldType,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): FieldConstraints {
  switch (type) {
    case 'input':
      return {
        ...validateLengthConstraints(field, index, context, issues),
        pattern: validatePatternConstraint(field, index, context, issues),
      };
    case 'textarea':
      return validateLengthConstraints(field, index, context, issues);
    case 'number':
      return validateNumberConstraints(field, index, context, issues);
    case 'select':
    case 'radio':
    case 'checkbox':
      return { optionValues: validateOptions(field, index, context, issues) };
    case 'password':
      validateSensitiveConstraint(field, index, context, issues);

      return {};
    case 'switch':
    case 'date':
      return {};
  }
}

function validateLengthConstraints(
  field: Record<string, unknown>,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): FieldConstraints {
  const minLength = readOptionalNumber(field, 'minLength', index, context, issues, {
    integer: true,
    requirement: '必须是非负整数',
    accepts: (value) => value >= 0,
  });
  const maxLength = readOptionalNumber(field, 'maxLength', index, context, issues, {
    integer: true,
    requirement: '必须是非负整数',
    accepts: (value) => value >= 0,
  });

  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    issues.push(
      createFormSchemaIssue(
        'CONSTRAINT_RANGE_INVALID',
        [index, 'minLength'],
        `minLength (${minLength}) 不能大于 maxLength (${maxLength})`,
        { ...context, property: 'minLength' },
      ),
    );
  }

  return { minLength, maxLength };
}

function validateNumberConstraints(
  field: Record<string, unknown>,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): FieldConstraints {
  const min = readOptionalNumber(field, 'min', index, context, issues);
  const max = readOptionalNumber(field, 'max', index, context, issues);

  readOptionalNumber(field, 'step', index, context, issues, {
    requirement: '必须是正数',
    accepts: (value) => value > 0,
  });

  if (min !== undefined && max !== undefined && min > max) {
    issues.push(
      createFormSchemaIssue(
        'CONSTRAINT_RANGE_INVALID',
        [index, 'min'],
        `min (${min}) 不能大于 max (${max})`,
        { ...context, property: 'min' },
      ),
    );
  }

  return { min, max };
}

function validatePatternConstraint(
  field: Record<string, unknown>,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): RegExp | undefined {
  const raw = field.pattern;

  if (raw === undefined) {
    return undefined;
  }

  const patternContext: FormSchemaIssueContext = { ...context, property: 'pattern' };

  if (!isString(raw)) {
    issues.push(
      createFormSchemaIssue(
        'PROPERTY_TYPE_INVALID',
        [index, 'pattern'],
        `pattern 必须是字符串，实际收到 ${describeValueType(raw)}`,
        patternContext,
      ),
    );

    return undefined;
  }

  if (raw.length > FORM_FIELD_PATTERN_MAX_LENGTH) {
    issues.push(
      createFormSchemaIssue(
        'CONSTRAINT_INVALID',
        [index, 'pattern'],
        `pattern 长度不能超过 ${FORM_FIELD_PATTERN_MAX_LENGTH}，实际长度 ${raw.length}`,
        patternContext,
      ),
    );

    return undefined;
  }

  try {
    return new RegExp(raw);
  } catch {
    issues.push(
      createFormSchemaIssue(
        'CONSTRAINT_INVALID',
        [index, 'pattern'],
        'pattern 不是合法的正则表达式',
        patternContext,
      ),
    );

    return undefined;
  }
}

function validateSensitiveConstraint(
  field: Record<string, unknown>,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): void {
  if (field.sensitive === false) {
    issues.push(
      createFormSchemaIssue(
        'SENSITIVE_REQUIRED',
        [index, 'sensitive'],
        'password 字段必须保持 sensitive: true，不允许显式关闭遮蔽',
        { ...context, property: 'sensitive' },
      ),
    );
  }
}

interface OptionalNumberRule {
  /** 是否要求安全整数。 */
  readonly integer?: boolean;
  /** 附加取值约束。 */
  readonly accepts?: (value: number) => boolean;
  /** 违反 `accepts` 或 `integer` 时写入错误信息的要求描述。 */
  readonly requirement?: string;
}

function readOptionalNumber(
  field: Record<string, unknown>,
  property: string,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
  rule: OptionalNumberRule = {},
): number | undefined {
  const raw = field[property];

  if (raw === undefined) {
    return undefined;
  }

  const propertyContext: FormSchemaIssueContext = { ...context, property };

  if (!isFiniteNumber(raw)) {
    issues.push(
      createFormSchemaIssue(
        'PROPERTY_TYPE_INVALID',
        [index, property],
        `${property} 必须是有限数字，实际收到 ${describeValueType(raw)}`,
        propertyContext,
      ),
    );

    return undefined;
  }

  const violatesInteger = rule.integer === true && !Number.isSafeInteger(raw);
  const violatesAccepts = rule.accepts !== undefined && !rule.accepts(raw);

  if (violatesInteger || violatesAccepts) {
    issues.push(
      createFormSchemaIssue(
        'CONSTRAINT_INVALID',
        [index, property],
        `${property} ${rule.requirement ?? '取值非法'}，实际收到 ${raw}`,
        propertyContext,
      ),
    );

    return undefined;
  }

  return raw;
}

function validateOptions(
  field: Record<string, unknown>,
  index: number,
  context: FormSchemaIssueContext,
  issues: FormSchemaIssue[],
): readonly FormFieldOptionValue[] | undefined {
  const raw = field.options;
  const optionsContext: FormSchemaIssueContext = { ...context, property: 'options' };

  if (raw === undefined) {
    issues.push(
      createFormSchemaIssue(
        'OPTIONS_MISSING',
        [index, 'options'],
        'select / radio / checkbox 必须提供 options',
        optionsContext,
      ),
    );

    return undefined;
  }

  if (!Array.isArray(raw)) {
    issues.push(
      createFormSchemaIssue(
        'OPTIONS_NOT_ARRAY',
        [index, 'options'],
        `options 必须是数组，实际收到 ${describeValueType(raw)}`,
        optionsContext,
      ),
    );

    return undefined;
  }

  if (raw.length === 0) {
    issues.push(
      createFormSchemaIssue(
        'OPTIONS_EMPTY',
        [index, 'options'],
        'options 不能为空数组',
        optionsContext,
      ),
    );

    return undefined;
  }

  const options: readonly unknown[] = raw;
  const values: FormFieldOptionValue[] = [];
  const seenValues = new Map<string, number>();
  let valid = true;

  options.forEach((option, optionIndex) => {
    if (!isPlainObject(option)) {
      issues.push(
        createFormSchemaIssue(
          'OPTION_NOT_OBJECT',
          [index, 'options', optionIndex],
          `选项必须是对象，实际收到 ${describeValueType(option)}`,
          optionsContext,
        ),
      );
      valid = false;

      return;
    }

    for (const property of findUnknownProperties(option, FORM_FIELD_OPTION_ALLOWED_PROPERTIES)) {
      issues.push(
        createFormSchemaIssue(
          'OPTION_UNKNOWN_PROPERTY',
          [index, 'options', optionIndex, property],
          `选项不允许属性 ${describeToken(property)}；` +
            `允许的属性为 [${FORM_FIELD_OPTION_ALLOWED_PROPERTIES.join(', ')}]`,
          { ...optionsContext, property },
        ),
      );
      valid = false;
    }

    if (!isNonEmptyPlainText(option.label)) {
      issues.push(
        createFormSchemaIssue(
          'OPTION_LABEL_INVALID',
          [index, 'options', optionIndex, 'label'],
          '选项 label 必须是非空纯文本，不允许空白串、控制字符或 HTML/XML 标签',
          optionsContext,
        ),
      );
      valid = false;
    }

    const value = option.value;

    if (!isString(value) && !isFiniteNumber(value)) {
      issues.push(
        createFormSchemaIssue(
          'OPTION_VALUE_INVALID',
          [index, 'options', optionIndex, 'value'],
          `选项 value 必须是字符串或有限数字，实际收到 ${describeValueType(value)}`,
          optionsContext,
        ),
      );
      valid = false;

      return;
    }

    const key = `${typeof value}:${String(value)}`;
    const firstIndex = seenValues.get(key);

    if (firstIndex !== undefined) {
      issues.push(
        createFormSchemaIssue(
          'OPTION_VALUE_DUPLICATE',
          [index, 'options', optionIndex, 'value'],
          `选项 value 与下标 ${firstIndex} 的选项重复，同一控件内必须唯一`,
          optionsContext,
        ),
      );
      valid = false;

      return;
    }

    seenValues.set(key, optionIndex);
    values.push(value);
  });

  return valid ? values : undefined;
}

function validateDefaultValue(
  field: Record<string, unknown>,
  type: FormFieldType,
  index: number,
  context: FormSchemaIssueContext,
  constraints: FieldConstraints,
  issues: FormSchemaIssue[],
): void {
  const value = field.defaultValue;

  if (value === undefined) {
    return;
  }

  const path = [index, 'defaultValue'];
  const defaultContext: FormSchemaIssueContext = { ...context, property: 'defaultValue' };

  const pushTypeIssue = (expected: string): void => {
    issues.push(
      createFormSchemaIssue(
        'DEFAULT_VALUE_TYPE_INVALID',
        path,
        `控件 ${type} 的 defaultValue 必须是 ${expected}，实际收到 ${describeValueType(value)}`,
        defaultContext,
      ),
    );
  };

  switch (type) {
    case 'input':
    case 'textarea':
    case 'password': {
      if (!isString(value)) {
        pushTypeIssue('string');

        return;
      }

      validateStringDefaultAgainstConstraints(value, path, defaultContext, constraints, issues);

      return;
    }

    case 'date': {
      if (!isString(value)) {
        pushTypeIssue('string');

        return;
      }

      if (!isCalendarDateString(value)) {
        issues.push(
          createFormSchemaIssue(
            'DEFAULT_VALUE_CONSTRAINT_VIOLATION',
            path,
            'date 的 defaultValue 必须是合法的 YYYY-MM-DD 日期',
            defaultContext,
          ),
        );
      }

      return;
    }

    case 'number': {
      if (!isFiniteNumber(value)) {
        pushTypeIssue('number');

        return;
      }

      if (constraints.min !== undefined && value < constraints.min) {
        issues.push(
          createFormSchemaIssue(
            'DEFAULT_VALUE_CONSTRAINT_VIOLATION',
            path,
            `defaultValue (${value}) 小于 min (${constraints.min})`,
            defaultContext,
          ),
        );
      }

      if (constraints.max !== undefined && value > constraints.max) {
        issues.push(
          createFormSchemaIssue(
            'DEFAULT_VALUE_CONSTRAINT_VIOLATION',
            path,
            `defaultValue (${value}) 大于 max (${constraints.max})`,
            defaultContext,
          ),
        );
      }

      return;
    }

    case 'switch': {
      if (!isBoolean(value)) {
        pushTypeIssue('boolean');
      }

      return;
    }

    case 'select':
    case 'radio': {
      if (!isString(value) && !isFiniteNumber(value)) {
        pushTypeIssue('string 或 number');

        return;
      }

      assertDefaultValueInOptions(value, path, defaultContext, constraints, issues);

      return;
    }

    case 'checkbox': {
      if (!Array.isArray(value)) {
        pushTypeIssue('(string | number)[]');

        return;
      }

      const items: readonly unknown[] = value;

      items.forEach((item, itemIndex) => {
        const itemPath = [...path, itemIndex];

        if (!isString(item) && !isFiniteNumber(item)) {
          issues.push(
            createFormSchemaIssue(
              'DEFAULT_VALUE_TYPE_INVALID',
              itemPath,
              `checkbox 的 defaultValue 元素必须是字符串或有限数字，` +
                `实际收到 ${describeValueType(item)}`,
              defaultContext,
            ),
          );

          return;
        }

        assertDefaultValueInOptions(item, itemPath, defaultContext, constraints, issues);
      });

      return;
    }
  }
}

function validateStringDefaultAgainstConstraints(
  value: string,
  path: readonly (string | number)[],
  context: FormSchemaIssueContext,
  constraints: FieldConstraints,
  issues: FormSchemaIssue[],
): void {
  if (constraints.minLength !== undefined && value.length < constraints.minLength) {
    issues.push(
      createFormSchemaIssue(
        'DEFAULT_VALUE_CONSTRAINT_VIOLATION',
        path,
        `defaultValue 长度 ${value.length} 小于 minLength (${constraints.minLength})`,
        context,
      ),
    );
  }

  if (constraints.maxLength !== undefined && value.length > constraints.maxLength) {
    issues.push(
      createFormSchemaIssue(
        'DEFAULT_VALUE_CONSTRAINT_VIOLATION',
        path,
        `defaultValue 长度 ${value.length} 大于 maxLength (${constraints.maxLength})`,
        context,
      ),
    );
  }

  if (constraints.pattern !== undefined && !constraints.pattern.test(value)) {
    issues.push(
      createFormSchemaIssue(
        'DEFAULT_VALUE_CONSTRAINT_VIOLATION',
        path,
        `defaultValue 不匹配 pattern ${describeToken(constraints.pattern.source)}`,
        context,
      ),
    );
  }
}

function assertDefaultValueInOptions(
  value: FormFieldOptionValue,
  path: readonly (string | number)[],
  context: FormSchemaIssueContext,
  constraints: FieldConstraints,
  issues: FormSchemaIssue[],
): void {
  // options 本身有问题时不再追加“不在候选中”的噪声错误。
  if (constraints.optionValues === undefined) {
    return;
  }

  if (!constraints.optionValues.includes(value)) {
    issues.push(
      createFormSchemaIssue(
        'DEFAULT_VALUE_NOT_ALLOWED',
        path,
        `defaultValue 必须是 options 中声明的取值之一（区分字符串与数字），` +
          `实际收到 ${describeToken(value)}`,
        context,
      ),
    );
  }
}
