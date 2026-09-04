<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import {
  validateFormConfigValues,
  type FormConfigIssue,
  type FormConfigValues,
  type FormField,
  type FormFieldOptionValue,
  type FormFieldValue,
  type FormSchema,
} from '@anvilrun/contracts';

const props = withDefaults(
  defineProps<{
    schema: FormSchema;
    modelValue: FormConfigValues;
    externalIssues?: readonly FormConfigIssue[];
    compact?: boolean;
  }>(),
  { externalIssues: () => [], compact: false },
);

const emit = defineEmits<{
  'update:modelValue': [value: FormConfigValues];
  'field-change': [fieldName: string];
  validation: [issues: readonly FormConfigIssue[]];
}>();

const localIssues = computed<readonly FormConfigIssue[]>(() => {
  const result = validateFormConfigValues(props.schema, props.modelValue);
  return result.ok ? [] : result.issues;
});

const displayIssues = computed<readonly FormConfigIssue[]>(() => {
  const seen = new Set<string>();
  return [...localIssues.value, ...props.externalIssues].filter((issue) => {
    const key = `${issue.code}:${issue.pointer}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

const topIssues = computed(() =>
  displayIssues.value.filter(
    (issue) => !issue.fieldName || !props.schema.some((field) => field.name === issue.fieldName),
  ),
);

function fieldIssues(fieldName: string): readonly FormConfigIssue[] {
  return displayIssues.value.filter(
    (issue) => issue.fieldName === fieldName || issue.path[0] === fieldName,
  );
}

function valueFor(field: FormField): unknown {
  const value = props.modelValue[field.name];
  if (value !== undefined) return value;
  if (field.disabled || field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === 'checkbox') return [];
  if (field.type === 'switch') return false;
  return undefined;
}

function textValue(field: FormField): string {
  const value = valueFor(field);
  return typeof value === 'string' ? value : '';
}

function numberValue(field: FormField): number | undefined {
  const value = valueFor(field);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionValue(field: FormField): FormFieldOptionValue | undefined {
  const value = valueFor(field);
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

function checkboxValue(field: FormField): FormFieldOptionValue[] {
  const value = valueFor(field);
  return Array.isArray(value)
    ? value.filter(
        (item): item is FormFieldOptionValue =>
          typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)),
      )
    : [];
}

function switchValue(field: FormField): boolean {
  return valueFor(field) === true;
}

function dateValue(field: FormField): string | undefined {
  const value = valueFor(field);
  return typeof value === 'string' ? value : undefined;
}

function options(field: FormField): readonly { label: string; value: FormFieldOptionValue }[] {
  return 'options' in field ? field.options : [];
}

function updateField(field: FormField, value: FormFieldValue): void {
  if (field.disabled) return;
  const next: FormConfigValues = { ...props.modelValue, [field.name]: value };
  emit('update:modelValue', next);
  emit('field-change', field.name);
}

function updateText(field: FormField, value: string): void {
  updateField(field, value);
}

function updateNumber(field: FormField, value: number | undefined): void {
  updateField(field, value === undefined ? null : value);
}

function updateOption(field: FormField, value: unknown): void {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
    updateField(field, value);
  }
}

function updateCheckbox(field: FormField, value: unknown): void {
  const next = Array.isArray(value)
    ? value.filter(
        (item): item is FormFieldOptionValue =>
          typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)),
      )
    : [];
  updateField(field, next);
}

function updateSwitch(field: FormField, value: unknown): void {
  if (typeof value === 'boolean') updateField(field, value);
}

function updateDate(field: FormField, value: string | undefined): void {
  updateField(field, value ?? null);
}

function emitValidation(): void {
  emit('validation', localIssues.value);
}

onMounted(emitValidation);
watch(localIssues, emitValidation);
</script>

<template>
  <div class="config-editor">
    <el-alert
      v-if="topIssues.length"
      title="配置校验失败"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    >
      <ul class="config-editor__issues">
        <li v-for="issue in topIssues" :key="`${issue.code}-${issue.pointer}`">
          {{ issue.message }}（{{ issue.pointer || '(root)' }}）
        </li>
      </ul>
    </el-alert>

    <el-empty v-if="schema.length === 0" description="当前模板没有配置项" />
    <el-form
      v-else
      :label-position="compact ? 'left' : 'top'"
      :label-width="compact ? '260px' : undefined"
      class="config-editor__form"
      :class="{ 'config-editor__form--compact': compact }"
    >
      <el-form-item
        v-for="field in schema"
        :key="field.name"
        :label="field.label"
        :required="field.required"
        :class="['config-editor__item', `config-editor__item--${field.type}`]"
      >
        <div v-if="field.description" class="config-editor__description">
          {{ field.description }}
        </div>
        <el-input
          v-if="field.type === 'input' || field.type === 'password'"
          :model-value="textValue(field)"
          :type="field.type === 'password' ? 'password' : 'text'"
          :placeholder="field.placeholder"
          :disabled="field.disabled"
          :show-password="field.type === 'password'"
          @update:model-value="updateText(field, $event)"
        />
        <el-input
          v-else-if="field.type === 'textarea'"
          :model-value="textValue(field)"
          type="textarea"
          :rows="4"
          :placeholder="field.placeholder"
          :disabled="field.disabled"
          @update:model-value="updateText(field, $event)"
        />
        <el-input-number
          v-else-if="field.type === 'number'"
          :model-value="numberValue(field)"
          :min="field.min"
          :max="field.max"
          :step="field.step"
          :disabled="field.disabled"
          class="full-width"
          @update:model-value="updateNumber(field, $event)"
        />
        <el-select
          v-else-if="field.type === 'select'"
          :model-value="optionValue(field)"
          :placeholder="field.placeholder"
          :disabled="field.disabled"
          class="full-width"
          @update:model-value="updateOption(field, $event)"
        >
          <el-option
            v-for="option in options(field)"
            :key="`${typeof option.value}:${option.value}`"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-radio-group
          v-else-if="field.type === 'radio'"
          :model-value="optionValue(field)"
          :disabled="field.disabled"
          @update:model-value="updateOption(field, $event)"
        >
          <el-radio
            v-for="option in options(field)"
            :key="`${typeof option.value}:${option.value}`"
            :value="option.value"
          >
            {{ option.label }}
          </el-radio>
        </el-radio-group>
        <el-checkbox-group
          v-else-if="field.type === 'checkbox'"
          :model-value="checkboxValue(field)"
          :disabled="field.disabled"
          @update:model-value="updateCheckbox(field, $event)"
        >
          <el-checkbox
            v-for="option in options(field)"
            :key="`${typeof option.value}:${option.value}`"
            :value="option.value"
          >
            {{ option.label }}
          </el-checkbox>
        </el-checkbox-group>
        <el-switch
          v-else-if="field.type === 'switch'"
          :model-value="switchValue(field)"
          :disabled="field.disabled"
          @update:model-value="updateSwitch(field, $event)"
        />
        <el-date-picker
          v-else-if="field.type === 'date'"
          :model-value="dateValue(field)"
          value-format="YYYY-MM-DD"
          type="date"
          :placeholder="field.placeholder"
          :disabled="field.disabled"
          class="full-width"
          @update:model-value="updateDate(field, $event)"
        />
        <ul v-if="fieldIssues(field.name).length" class="config-editor__field-issues">
          <li v-for="issue in fieldIssues(field.name)" :key="issue.pointer">
            {{ issue.message }}（{{ issue.pointer || '(root)' }}）
          </li>
        </ul>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
.config-editor__form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.config-editor__item {
  margin-bottom: 20px;
}

.config-editor__description {
  width: 100%;
  margin-bottom: 6px;
  color: var(--ar-text-secondary);
  font-size: 13px;
  white-space: pre-wrap;
  line-height: 1.4;
}

.config-editor__issues {
  margin: 0;
  padding-left: 20px;
}

.config-editor__issues li {
  margin: 4px 0;
  font-size: 13px;
}

.config-editor__field-issues {
  width: 100%;
  margin: 6px 0 0;
  padding-left: 20px;
  color: var(--ar-status-danger);
  font-size: 13px;
}

.config-editor__field-issues li {
  margin-top: 2px;
}

.config-editor__form--compact {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-editor__form--compact .config-editor__item {
  width: 100%;
  min-width: 0;
  margin-bottom: 8px;
}

.config-editor__form--compact .config-editor__item :deep(.el-form-item__content) {
  min-width: 0;
}

.config-editor__form--compact .config-editor__item :deep(.el-input),
.config-editor__form--compact .config-editor__item :deep(.el-input-number),
.config-editor__form--compact .config-editor__item :deep(.el-select),
.config-editor__form--compact .config-editor__item :deep(.el-date-editor) {
  width: 100%;
  max-width: 100%;
}

.config-editor__form--compact .config-editor__item :deep(.el-radio-group),
.config-editor__form--compact .config-editor__item :deep(.el-checkbox-group) {
  max-width: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}

@media (max-width: 768px) {
  .config-editor__form--compact .config-editor__item :deep(.el-form-item__label) {
    width: min(45%, 180px) !important;
    flex: 0 0 min(45%, 180px);
  }
}
</style>
