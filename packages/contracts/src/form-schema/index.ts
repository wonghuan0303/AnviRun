/** 配置表单模板契约（产品设计第 6 节）。 */

export {
  FORM_FIELD_ALLOWED_PROPERTIES,
  FORM_FIELD_COMMON_PROPERTIES,
  FORM_FIELD_DATE_PATTERN,
  FORM_FIELD_NAME_MAX_LENGTH,
  FORM_FIELD_NAME_PATTERN,
  FORM_FIELD_PATTERN_MAX_LENGTH,
  FORM_FIELD_TYPES,
  OPTION_BASED_FORM_FIELD_TYPES,
  isOptionBasedFormFieldType,
} from './field-types';
export type {
  CheckboxFormField,
  DateFormField,
  FormField,
  FormFieldCommon,
  FormFieldOption,
  FormFieldOptionValue,
  FormFieldType,
  FormSchema,
  InputFormField,
  NumberFormField,
  OptionBasedFormFieldType,
  PasswordFormField,
  RadioFormField,
  SelectFormField,
  SwitchFormField,
  TextareaFormField,
} from './field-types';

export type { FormConfigValues, FormFieldValue } from './values';

export { FORM_SCHEMA_ISSUE_CODES, createFormSchemaIssue } from './issues';
export type { FormSchemaIssue, FormSchemaIssueCode, FormSchemaIssueContext } from './issues';

export {
  isFormSchema,
  isSensitiveFormField,
  listSensitiveFormFieldNames,
  parseFormSchema,
  validateFormSchema,
} from './validate';
export type { FormSchemaValidationFailure, FormSchemaValidationResult } from './validate';

export {
  FORM_SCHEMA_JSON_SCHEMA,
  FORM_SCHEMA_JSON_SCHEMA_ID,
  FORM_SCHEMA_RUNTIME_ONLY_RULES,
} from './json-schema';
export type { JsonSchemaDocument } from './json-schema';
