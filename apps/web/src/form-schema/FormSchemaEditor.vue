<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { FormSchema, FormSchemaIssue } from '@anvilrun/contracts';

import FormSchemaPreview from './FormSchemaPreview.vue';
import { parseFormSchemaText, type JsonSyntaxIssue } from './schema';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    externalIssues?: readonly FormSchemaIssue[];
  }>(),
  { externalIssues: () => [] },
);
const emit = defineEmits<{
  'update:modelValue': [value: string];
  'schema-change': [];
  validation: [
    value: {
      schema: FormSchema | null;
      issues: readonly FormSchemaIssue[];
      syntaxIssue: JsonSyntaxIssue | null;
    },
  ];
}>();

const text = ref(props.modelValue);
const schema = ref<FormSchema | null>(null);
const issues = ref<readonly FormSchemaIssue[]>([]);
const syntaxIssue = ref<JsonSyntaxIssue | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const displayIssues = computed(() => {
  const seen = new Set<string>();
  return [...issues.value, ...props.externalIssues].filter((issue) => {
    const key = `${issue.code}:${issue.pointer}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

watch(
  () => props.modelValue,
  (value) => {
    if (value !== text.value) {
      text.value = value;
      parse();
    }
  },
);

function emitValidation(): void {
  emit('validation', {
    schema: schema.value,
    issues: issues.value,
    syntaxIssue: syntaxIssue.value,
  });
}

function parse(): void {
  const result = parseFormSchemaText(text.value);
  schema.value = result.value;
  issues.value = result.issues;
  syntaxIssue.value = result.syntaxIssue;
  emitValidation();
}

function markChanged(): void {
  emit('schema-change');
}

function update(value: string): void {
  text.value = value;
  emit('update:modelValue', value);
  markChanged();
  parse();
}

function formatJson(): void {
  try {
    update(JSON.stringify(JSON.parse(text.value), null, 2));
  } catch {
    markChanged();
    parse();
  }
}

function reset(): void {
  update('[]');
}

async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  markChanged();
  if (!file.name.toLowerCase().endsWith('.json')) {
    syntaxIssue.value = { message: '只能上传 .json 文件' };
    emitValidation();
    return;
  }
  if (file.size > 1024 * 1024) {
    syntaxIssue.value = { message: 'JSON 文件不能超过 1 MB' };
    emitValidation();
    return;
  }
  update(await file.text());
}

function issueLocation(issue: FormSchemaIssue): string {
  const details = [issue.pointer || '(root)'];
  if (issue.fieldIndex !== undefined) details.push(`字段 #${issue.fieldIndex + 1}`);
  if (issue.fieldName) details.push(`name=${issue.fieldName}`);
  if (issue.property) details.push(`属性=${issue.property}`);
  return details.join(' · ');
}

onMounted(parse);
</script>

<template>
  <div class="schema-editor">
    <div class="schema-editor__toolbar">
      <el-button size="small" @click="fileInput?.click()">上传 JSON</el-button>
      <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="upload" />
      <el-button size="small" @click="formatJson">格式化 JSON</el-button>
      <el-button size="small" @click="reset">重置为空数组</el-button>
    </div>
    <div class="schema-editor__input-wrapper">
      <el-input
        :model-value="text"
        type="textarea"
        :rows="16"
        spellcheck="false"
        aria-label="formSchema JSON"
        class="schema-textarea"
        @update:model-value="update"
      />
    </div>
    <el-alert v-if="syntaxIssue" type="error" show-icon :closable="false" class="page-alert">
      <template #title>JSON 语法错误</template>
      <div>
        {{ syntaxIssue.message }}
        <span v-if="syntaxIssue.line">
          （第 {{ syntaxIssue.line }} 行，第 {{ syntaxIssue.column }} 列）
        </span>
      </div>
    </el-alert>
    <el-alert
      v-if="!syntaxIssue && displayIssues.length"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    >
      <template #title>formSchema 协议校验失败</template>
      <ul class="schema-editor__issues">
        <li
          v-for="(issue, index) in displayIssues"
          :key="`${issue.code}-${issue.pointer}-${index}`"
        >
          <span>{{ issue.message }}</span>
          <small>{{ issueLocation(issue) }}</small>
        </li>
      </ul>
    </el-alert>
    <div v-if="schema && !syntaxIssue && !displayIssues.length" class="schema-editor__preview">
      <div class="subsection-title">动态预览（仅展示）</div>
      <div class="preview-box">
        <FormSchemaPreview :schema="schema" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.schema-editor {
  width: 100%;
}

.schema-editor__toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.schema-textarea :deep(textarea) {
  font-family: var(--ar-font-mono);
  background-color: var(--ar-bg-terminal);
  color: #f1f5f9;
  font-size: 13px;
  line-height: 1.5;
  border-radius: var(--ar-radius-md);
  border: 1px solid var(--ar-color-slate-800);
}

.schema-editor__issues {
  margin: 0;
  padding-left: 20px;
}

.schema-editor__issues li {
  margin: 6px 0;
  font-size: 13px;
}

.schema-editor__issues small {
  display: block;
  color: var(--ar-text-secondary);
  font-size: 12px;
  margin-top: 2px;
}

.schema-editor__preview {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px dashed var(--ar-border-color);
}

.preview-box {
  background: var(--ar-bg-subtle);
  border: 1px solid var(--ar-border-color);
  border-radius: var(--ar-radius-lg);
  padding: 20px;
  margin-top: 10px;
}
</style>
