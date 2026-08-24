/**
 * 配置表单模板的 JSON Schema（Draft 2020-12）。
 *
 * 用途：给**非 TypeScript 消费方**（运维脚本、编辑器 JSON 校验、未来可能的其它语言实现）
 * 提供结构化校验能力。本文件是唯一来源，`packages/contracts/schemas/form-schema.schema.json`
 * 是它的发布副本，两者一致性由 `json-schema.spec.ts` 断言。
 *
 * **权威性**：跨字段与语义规则无法用标准 JSON Schema 表达，因此
 * {@link validateFormSchema} 才是权威校验器。JSON Schema 只覆盖结构与单字段约束，
 * 未覆盖的规则列在 `x-runtimeOnlyRules` 中。
 */

import {
  FORM_FIELD_NAME_PATTERN,
  FORM_FIELD_PATTERN_MAX_LENGTH,
  FORM_FIELD_TYPES,
} from './field-types';

/** JSON Schema 文档的最小结构约定。 */
export interface JsonSchemaDocument {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
  readonly [keyword: string]: unknown;
}

/** JSON Schema 的 `$id`，同时作为发布副本的稳定标识。 */
export const FORM_SCHEMA_JSON_SCHEMA_ID =
  'https://buildplatform.local/schemas/form-schema.schema.json';

/**
 * 标准 JSON Schema 无法表达、只能由运行时校验器覆盖的规则。
 *
 * 与 {@link FORM_SCHEMA_ISSUE_CODES} 中的对应错误码一一相关。
 */
export const FORM_SCHEMA_RUNTIME_ONLY_RULES: readonly string[] = [
  '同一模板内 name 必须唯一（FIELD_NAME_DUPLICATE）',
  'select / radio 的 defaultValue 必须出现在 options 中（DEFAULT_VALUE_NOT_ALLOWED）',
  'checkbox 的 defaultValue 每一项都必须出现在 options 中（DEFAULT_VALUE_NOT_ALLOWED）',
  'options[].value 按“类型 + 取值”去重；uniqueItems 只能识别整项重复（OPTION_VALUE_DUPLICATE）',
  'minLength 不得大于 maxLength、min 不得大于 max（CONSTRAINT_RANGE_INVALID）',
  'pattern 必须可被 new RegExp() 编译（CONSTRAINT_INVALID）',
  'defaultValue 必须同时满足 minLength / maxLength / pattern / min / max（DEFAULT_VALUE_CONSTRAINT_VIOLATION）',
  'label、placeholder、description、options[].label 必须是纯文本：不含控制字符，不含 HTML/XML 标签（FIELD_LABEL_INVALID、PROPERTY_TYPE_INVALID、OPTION_LABEL_INVALID）',
  'date 的 defaultValue 必须是日历上真实存在的日期，含闰年判定（DEFAULT_VALUE_CONSTRAINT_VIOLATION）',
];

const OPTION_VALUE_DEF = { type: ['string', 'number'] } as const;

const COMMON_PROPERTIES = {
  name: { $ref: '#/$defs/fieldName' },
  label: { $ref: '#/$defs/fieldLabel' },
  required: { type: 'boolean' },
  placeholder: { $ref: '#/$defs/plainText' },
  description: { $ref: '#/$defs/plainText' },
  disabled: { type: 'boolean' },
  sensitive: { type: 'boolean' },
} as const;

const REQUIRED_PROPERTIES = ['type', 'name', 'label'] as const;

/**
 * 配置表单模板 JSON Schema。
 *
 * 每个控件定义都内联全部允许属性并声明 `additionalProperties: false`：
 * JSON Schema 中 `additionalProperties` 不能穿透 `$ref` / `allOf`，
 * 因此不能把公共属性抽成一个被组合的子 Schema，只能逐个展开。
 */
export const FORM_SCHEMA_JSON_SCHEMA: JsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: FORM_SCHEMA_JSON_SCHEMA_ID,
  title: '构建平台配置表单模板',
  description:
    '管理员上传的配置表单模板：字段数组，允许为空数组。控件类型限定为白名单，' +
    '不允许任意组件名、事件、插槽、HTML 或未批准属性。',
  'x-runtimeOnlyRules': FORM_SCHEMA_RUNTIME_ONLY_RULES,
  type: 'array',
  items: { $ref: '#/$defs/formField' },
  $defs: {
    fieldName: {
      description: '配置键，同一模板内唯一',
      type: 'string',
      pattern: FORM_FIELD_NAME_PATTERN.source,
    },
    fieldLabel: {
      description: '页面显示名称，非空纯文本',
      type: 'string',
      minLength: 1,
    },
    plainText: {
      description: '纯文本；“无控制字符、无标签”由运行时校验器保证',
      type: 'string',
    },
    optionValue: OPTION_VALUE_DEF,
    option: {
      type: 'object',
      required: ['label', 'value'],
      additionalProperties: false,
      properties: {
        label: { type: 'string', minLength: 1 },
        value: { $ref: '#/$defs/optionValue' },
      },
    },
    options: {
      description: 'select / radio / checkbox 的候选项，至少一项',
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { $ref: '#/$defs/option' },
    },
    formField: {
      description: `按 type 判别的控件定义，type 取值限定为 ${FORM_FIELD_TYPES.join(' | ')}`,
      oneOf: [
        { $ref: '#/$defs/inputField' },
        { $ref: '#/$defs/textareaField' },
        { $ref: '#/$defs/numberField' },
        { $ref: '#/$defs/selectField' },
        { $ref: '#/$defs/radioField' },
        { $ref: '#/$defs/checkboxField' },
        { $ref: '#/$defs/switchField' },
        { $ref: '#/$defs/dateField' },
        { $ref: '#/$defs/passwordField' },
      ],
    },
    inputField: {
      type: 'object',
      required: REQUIRED_PROPERTIES,
      additionalProperties: false,
      properties: {
        type: { const: 'input' },
        ...COMMON_PROPERTIES,
        defaultValue: { type: 'string' },
        minLength: { type: 'integer', minimum: 0 },
        maxLength: { type: 'integer', minimum: 0 },
        pattern: { type: 'string', maxLength: FORM_FIELD_PATTERN_MAX_LENGTH },
      },
    },
    textareaField: {
      type: 'object',
      required: REQUIRED_PROPERTIES,
      additionalProperties: false,
      properties: {
        type: { const: 'textarea' },
        ...COMMON_PROPERTIES,
        defaultValue: { type: 'string' },
        minLength: { type: 'integer', minimum: 0 },
        maxLength: { type: 'integer', minimum: 0 },
      },
    },
    numberField: {
      type: 'object',
      required: REQUIRED_PROPERTIES,
      additionalProperties: false,
      properties: {
        type: { const: 'number' },
        ...COMMON_PROPERTIES,
        defaultValue: { type: 'number' },
        min: { type: 'number' },
        max: { type: 'number' },
        step: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    selectField: {
      type: 'object',
      required: [...REQUIRED_PROPERTIES, 'options'],
      additionalProperties: false,
      properties: {
        type: { const: 'select' },
        ...COMMON_PROPERTIES,
        defaultValue: { $ref: '#/$defs/optionValue' },
        options: { $ref: '#/$defs/options' },
      },
    },
    radioField: {
      type: 'object',
      required: [...REQUIRED_PROPERTIES, 'options'],
      additionalProperties: false,
      properties: {
        type: { const: 'radio' },
        ...COMMON_PROPERTIES,
        defaultValue: { $ref: '#/$defs/optionValue' },
        options: { $ref: '#/$defs/options' },
      },
    },
    checkboxField: {
      type: 'object',
      required: [...REQUIRED_PROPERTIES, 'options'],
      additionalProperties: false,
      properties: {
        type: { const: 'checkbox' },
        ...COMMON_PROPERTIES,
        defaultValue: {
          type: 'array',
          uniqueItems: true,
          items: { $ref: '#/$defs/optionValue' },
        },
        options: { $ref: '#/$defs/options' },
      },
    },
    switchField: {
      type: 'object',
      required: REQUIRED_PROPERTIES,
      additionalProperties: false,
      properties: {
        type: { const: 'switch' },
        ...COMMON_PROPERTIES,
        defaultValue: { type: 'boolean' },
      },
    },
    dateField: {
      type: 'object',
      required: REQUIRED_PROPERTIES,
      additionalProperties: false,
      properties: {
        type: { const: 'date' },
        ...COMMON_PROPERTIES,
        defaultValue: {
          description: 'YYYY-MM-DD；日历有效性由运行时校验器保证',
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
      },
    },
    passwordField: {
      type: 'object',
      required: REQUIRED_PROPERTIES,
      additionalProperties: false,
      properties: {
        type: { const: 'password' },
        ...COMMON_PROPERTIES,
        // password 恒为敏感字段，不允许显式关闭遮蔽。
        sensitive: { const: true },
        defaultValue: { type: 'string' },
      },
    },
  },
};
