/**
 * 配置表单模板类型定义。
 *
 * 对应产品设计第 6 节。模板是一个 JSON 字段数组，由管理员上传并作为构建模板的一部分
 * 保存；Web 按控件白名单渲染，Server 用同一份定义做二次校验。
 *
 * 安全前提：模板**不允许**指定任意 Vue / Element Plus 组件名、事件、插槽、HTML 或
 * 未批准属性。每种控件的允许属性集合在 {@link FORM_FIELD_ALLOWED_PROPERTIES} 中枚举，
 * 校验器拒绝任何超出集合的属性。
 */

/** 全部合法控件类型，顺序稳定，可直接用于管理端下拉与文档。 */
export const FORM_FIELD_TYPES = [
  'input',
  'textarea',
  'number',
  'select',
  'radio',
  'checkbox',
  'switch',
  'date',
  'password',
] as const;

/** 控件类型。 */
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/**
 * 配置项 `name` 的格式约束（产品设计 6.2）：首字符为字母或下划线，
 * 其后允许字母、数字、下划线、点与连字符，总长度 1–64。
 */
export const FORM_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** `name` 允许的最大长度，与 {@link FORM_FIELD_NAME_PATTERN} 保持一致。 */
export const FORM_FIELD_NAME_MAX_LENGTH = 64;

/** 选项值类型。`checkbox` 的值是该类型的数组。 */
export type FormFieldOptionValue = string | number;

/** 下拉、单选、多选控件的单个选项。 */
export interface FormFieldOption {
  /** 页面显示文案，必填纯文本。 */
  readonly label: string;
  /** 写入项目配置的实际值，同一控件内必须唯一。 */
  readonly value: FormFieldOptionValue;
}

/** 所有控件共有的字段（产品设计 6.2）。 */
export interface FormFieldCommon<TType extends FormFieldType, TValue> {
  /** 控件类型，判别属性。 */
  readonly type: TType;
  /** 配置键，同一模板内唯一，格式见 {@link FORM_FIELD_NAME_PATTERN}。 */
  readonly name: string;
  /** 页面显示名称，必填非空纯文本。 */
  readonly label: string;
  /** 可选默认值，类型必须与控件匹配。 */
  readonly defaultValue?: TValue;
  /** 是否必填，缺省为 `false`。 */
  readonly required?: boolean;
  /** 可选输入提示，纯文本。 */
  readonly placeholder?: string;
  /** 可选字段说明，纯文本。 */
  readonly description?: string;
  /** 是否禁用。禁用字段仍会使用默认值参与构建（产品设计 6.2）。 */
  readonly disabled?: boolean;
  /** 是否敏感。敏感值在展示、日志与导出中必须遮蔽（产品设计 6.2、第 12 节）。 */
  readonly sensitive?: boolean;
}

/** 单行文本输入。 */
export interface InputFormField extends FormFieldCommon<'input', string> {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** JavaScript 正则源码字符串，必须可被 `new RegExp()` 编译。 */
  readonly pattern?: string;
}

/** 多行文本输入。 */
export interface TextareaFormField extends FormFieldCommon<'textarea', string> {
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** 数字输入。 */
export interface NumberFormField extends FormFieldCommon<'number', number> {
  readonly min?: number;
  readonly max?: number;
  /** 步长，必须为正有限数。 */
  readonly step?: number;
}

/** 单选下拉。 */
export interface SelectFormField extends FormFieldCommon<'select', FormFieldOptionValue> {
  readonly options: readonly FormFieldOption[];
}

/** 单选按钮组。 */
export interface RadioFormField extends FormFieldCommon<'radio', FormFieldOptionValue> {
  readonly options: readonly FormFieldOption[];
}

/** 多选框组，值为选项值数组。 */
export interface CheckboxFormField extends FormFieldCommon<
  'checkbox',
  readonly FormFieldOptionValue[]
> {
  readonly options: readonly FormFieldOption[];
}

/** 开关，值为布尔。 */
export type SwitchFormField = FormFieldCommon<'switch', boolean>;

/** 日期选择，值为 `YYYY-MM-DD` 字符串。 */
export type DateFormField = FormFieldCommon<'date', string>;

/**
 * 密码输入。
 *
 * `sensitive` 恒为 `true`：校验器会在缺省时补全，并拒绝显式写 `false`
 * （避免密码进入日志与导出，见产品设计第 12 节）。
 */
export type PasswordFormField = FormFieldCommon<'password', string>;

/** 配置表单字段判别联合，判别属性为 `type`。 */
export type FormField =
  | InputFormField
  | TextareaFormField
  | NumberFormField
  | SelectFormField
  | RadioFormField
  | CheckboxFormField
  | SwitchFormField
  | DateFormField
  | PasswordFormField;

/** 配置表单模板：字段数组，允许为空数组（产品设计 5.2）。 */
export type FormSchema = readonly FormField[];

/** `date` 控件默认值的格式：`YYYY-MM-DD`。 */
export const FORM_FIELD_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `input.pattern` 允许的最大长度。
 *
 * 这是技术性安全上限，不是产品约束：校验器会用该正则测试 `defaultValue`，
 * 过长的正则会放大灾难性回溯（ReDoS）风险。
 */
export const FORM_FIELD_PATTERN_MAX_LENGTH = 512;

/** 带选项的控件类型。 */
export const OPTION_BASED_FORM_FIELD_TYPES = ['select', 'radio', 'checkbox'] as const;

/** 带选项的控件类型。 */
export type OptionBasedFormFieldType = (typeof OPTION_BASED_FORM_FIELD_TYPES)[number];

/** 判断控件类型是否需要 `options`。 */
export function isOptionBasedFormFieldType(type: FormFieldType): type is OptionBasedFormFieldType {
  return (OPTION_BASED_FORM_FIELD_TYPES as readonly FormFieldType[]).includes(type);
}

/** 所有控件共有的允许属性名。 */
export const FORM_FIELD_COMMON_PROPERTIES = [
  'type',
  'name',
  'label',
  'defaultValue',
  'required',
  'placeholder',
  'description',
  'disabled',
  'sensitive',
] as const;

/**
 * 每种控件允许出现的完整属性集合（含公共属性）。
 *
 * 校验器据此拒绝未知属性，从而一并挡掉 `component`、`is`、`onClick`、`@click`、
 * `v-html`、`slots` 等未批准或危险属性。
 */
export const FORM_FIELD_ALLOWED_PROPERTIES: Readonly<Record<FormFieldType, readonly string[]>> = {
  input: [...FORM_FIELD_COMMON_PROPERTIES, 'minLength', 'maxLength', 'pattern'],
  textarea: [...FORM_FIELD_COMMON_PROPERTIES, 'minLength', 'maxLength'],
  number: [...FORM_FIELD_COMMON_PROPERTIES, 'min', 'max', 'step'],
  select: [...FORM_FIELD_COMMON_PROPERTIES, 'options'],
  radio: [...FORM_FIELD_COMMON_PROPERTIES, 'options'],
  checkbox: [...FORM_FIELD_COMMON_PROPERTIES, 'options'],
  switch: [...FORM_FIELD_COMMON_PROPERTIES],
  date: [...FORM_FIELD_COMMON_PROPERTIES],
  password: [...FORM_FIELD_COMMON_PROPERTIES],
};
