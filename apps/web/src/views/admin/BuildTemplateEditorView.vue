<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { FormSchema, FormSchemaIssue } from '@buildplatform/contracts';

import * as agentsApi from '@/api/agents';
import * as templatesApi from '@/api/build-templates';
import type { AgentSummary } from '@/api/types';
import { errorDetails, errorMessage } from '@/utils/errors';
import { isFormSchemaIssues, schemaText, type JsonSyntaxIssue } from '@/form-schema/schema';
import FormSchemaEditor from '@/form-schema/FormSchemaEditor.vue';

const route = useRoute();
const router = useRouter();
const id = computed(() => (typeof route.params.id === 'string' ? route.params.id : null));
const editing = computed(() => id.value !== null);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const agents = ref<AgentSummary[]>([]);
const localSchemaIssues = ref<readonly FormSchemaIssue[]>([]);
const serverSchemaIssues = ref<readonly FormSchemaIssue[]>([]);
const schemaSyntaxIssue = ref<JsonSyntaxIssue | null>(null);
const parsedSchema = ref<FormSchema | null>([]);
const form = reactive({
  name: '',
  description: '',
  agentId: '',
  gitUrl: '',
  command: '',
  artifactDir: '',
  timeoutSeconds: 3600,
  formSchema: schemaText([]),
});

const enabledAgents = computed(() => agents.value);
const title = computed(() => (editing.value ? '编辑构建模板' : '新建构建模板'));

async function loadAgents(): Promise<void> {
  const result = await agentsApi.listAgents({ page: 1, pageSize: 100 });
  agents.value = result.items;
}
async function loadTemplate(): Promise<void> {
  if (!id.value) return;
  const result = await templatesApi.getBuildTemplate(id.value);
  const template = result.template;
  form.name = template.name;
  form.description = template.description ?? '';
  form.agentId = template.agentId;
  form.gitUrl = template.gitUrl;
  form.command = template.command;
  form.artifactDir = template.artifactDir;
  form.timeoutSeconds = template.timeoutSeconds;
  form.formSchema = schemaText(template.formSchema);
}
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await Promise.all([loadAgents(), loadTemplate()]);
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}
function onSchemaValidation(value: {
  schema: FormSchema | null;
  issues: readonly FormSchemaIssue[];
  syntaxIssue: JsonSyntaxIssue | null;
}): void {
  parsedSchema.value = value.schema;
  localSchemaIssues.value = value.issues;
  schemaSyntaxIssue.value = value.syntaxIssue;
}
function clearServerSchemaIssues(): void {
  serverSchemaIssues.value = [];
}
function displayAgent(agent: AgentSummary): string {
  return `${agent.name}（${agent.enabled ? agent.status : '已停用'}）`;
}
function isAgentDisabled(agent: AgentSummary): boolean {
  return !agent.enabled && agent.id !== form.agentId;
}
function validate(): boolean {
  if (
    !form.name.trim() ||
    !form.agentId ||
    !form.gitUrl.trim() ||
    !form.command.trim() ||
    !form.artifactDir.trim()
  ) {
    error.value = '请填写所有必填字段';
    return false;
  }
  if (schemaSyntaxIssue.value || !parsedSchema.value || localSchemaIssues.value.length) {
    error.value = '请先修复 formSchema JSON 和协议错误';
    return false;
  }
  return true;
}
function serverIssues(caught: unknown): readonly FormSchemaIssue[] {
  const details = errorDetails(caught);
  const candidate = details?.issues;
  return isFormSchemaIssues(candidate) ? candidate : [];
}
async function save(): Promise<void> {
  if (!validate()) return;
  saving.value = true;
  error.value = '';
  clearServerSchemaIssues();
  const input: templatesApi.BuildTemplateInput = {
    name: form.name.trim(),
    description: form.description.trim() || null,
    agentId: form.agentId,
    gitUrl: form.gitUrl.trim(),
    command: form.command,
    artifactDir: form.artifactDir.trim(),
    timeoutSeconds: Number(form.timeoutSeconds),
    formSchema: parsedSchema.value,
  };
  try {
    if (id.value) await templatesApi.updateBuildTemplate(id.value, input);
    else await templatesApi.createBuildTemplate(input);
    ElMessage.success(editing.value ? '模板已保存' : '模板创建成功');
    await router.replace({ name: 'admin-build-templates' });
  } catch (caught) {
    serverSchemaIssues.value = serverIssues(caught);
    error.value = errorMessage(caught);
  } finally {
    saving.value = false;
  }
}
onMounted(() => {
  void load();
});
</script>

<template>
  <section class="page-section">
    <div class="page-heading">
      <div>
        <h1>{{ title }}</h1>
        <p>表单协议只在浏览器本地解析和预览，保存时提交校验后的 JSON。</p>
      </div>
      <el-button @click="router.back()">返回列表</el-button>
    </div>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    />
    <el-skeleton v-if="loading" :rows="8" animated />
    <el-card v-else shadow="never">
      <el-form label-position="top" class="template-form" @submit.prevent="save">
        <div class="form-grid">
          <el-form-item label="名称" required
            ><el-input v-model="form.name" maxlength="120"
          /></el-form-item>
          <el-form-item label="Agent" required>
            <el-select
              v-model="form.agentId"
              filterable
              class="full-width"
              placeholder="选择 Agent"
            >
              <el-option
                v-for="agent in enabledAgents"
                :key="agent.id"
                :label="displayAgent(agent)"
                :value="agent.id"
                :disabled="isAgentDisabled(agent)"
              >
                <span>{{ displayAgent(agent) }}</span>
                <small v-if="agent.enabled && agent.status === 'OFFLINE'" class="option-hint"
                  >（当前离线，可绑定）</small
                >
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="Git URL" required
            ><el-input v-model="form.gitUrl" placeholder="https://..."
          /></el-form-item>
          <el-form-item label="产物目录" required
            ><el-input v-model="form.artifactDir" placeholder="例如 dist"
          /></el-form-item>
        </div>
        <el-form-item label="说明"
          ><el-input v-model="form.description" type="textarea" :rows="2"
        /></el-form-item>
        <el-form-item label="构建命令" required
          ><el-input v-model="form.command" type="textarea" :rows="5" spellcheck="false"
        /></el-form-item>
        <el-form-item label="超时（秒）" required
          ><el-input-number v-model="form.timeoutSeconds" :min="1" :max="86400"
        /></el-form-item>
        <el-form-item label="formSchema JSON" required>
          <FormSchemaEditor
            v-model="form.formSchema"
            :external-issues="serverSchemaIssues"
            @validation="onSchemaValidation"
            @schema-change="clearServerSchemaIssues"
          />
        </el-form-item>
        <div class="form-actions">
          <el-button @click="router.back()">取消</el-button
          ><el-button type="primary" :loading="saving" @click="save">保存模板</el-button>
        </div>
      </el-form>
    </el-card>
  </section>
</template>
