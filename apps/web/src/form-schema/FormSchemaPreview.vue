<script setup lang="ts">
import type { FormField, FormSchema } from '@anvilrun/contracts';

defineProps<{ schema: FormSchema }>();

function options(field: FormField): readonly { label: string; value: string | number }[] {
  return 'options' in field ? field.options : [];
}
</script>

<template>
  <el-empty v-if="schema.length === 0" description="空表单，不需要填写配置" />
  <el-form v-else label-position="top" class="schema-preview">
    <el-form-item
      v-for="field in schema"
      :key="field.name"
      :label="field.label"
      :required="field.required"
    >
      <el-input
        v-if="field.type === 'input' || field.type === 'textarea' || field.type === 'password'"
        :type="
          field.type === 'textarea' ? 'textarea' : field.type === 'password' ? 'password' : 'text'
        "
        :placeholder="field.placeholder"
        :model-value="typeof field.defaultValue === 'string' ? field.defaultValue : ''"
        :rows="field.type === 'textarea' ? 3 : undefined"
        :show-password="true"
        disabled
      />
      <el-input-number
        v-else-if="field.type === 'number'"
        :model-value="typeof field.defaultValue === 'number' ? field.defaultValue : undefined"
        :min="field.min"
        :max="field.max"
        :step="field.step"
        disabled
      />
      <el-select
        v-else-if="field.type === 'select'"
        :model-value="field.defaultValue"
        disabled
        class="schema-preview__control"
      >
        <el-option v-for="option in options(field)" :key="`${option.value}`" v-bind="option" />
      </el-select>
      <el-radio-group v-else-if="field.type === 'radio'" :model-value="field.defaultValue" disabled>
        <el-radio v-for="option in options(field)" :key="`${option.value}`" :value="option.value">
          {{ option.label }}
        </el-radio>
      </el-radio-group>
      <el-checkbox-group
        v-else-if="field.type === 'checkbox'"
        :model-value="Array.isArray(field.defaultValue) ? field.defaultValue : []"
        disabled
      >
        <el-checkbox
          v-for="option in options(field)"
          :key="`${option.value}`"
          :value="option.value"
        >
          {{ option.label }}
        </el-checkbox>
      </el-checkbox-group>
      <el-switch
        v-else-if="field.type === 'switch'"
        :model-value="field.defaultValue === true"
        disabled
      />
      <el-date-picker
        v-else-if="field.type === 'date'"
        type="date"
        :model-value="typeof field.defaultValue === 'string' ? field.defaultValue : undefined"
        disabled
      />
    </el-form-item>
  </el-form>
</template>

<style scoped>
.schema-preview__control {
  width: 100%;
}
</style>
