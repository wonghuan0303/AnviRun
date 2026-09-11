<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { FormSchema, FormSchemaIssue } from '@anvilrun/contracts';

import * as agentsApi from '@/api/agents';
import * as templatesApi from '@/api/build-templates';
import type { AgentSummary } from '@/api/types';
import FormSchemaEditor from '@/form-schema/FormSchemaEditor.vue';
import { isFormSchemaIssues, schemaText, type JsonSyntaxIssue } from '@/form-schema/schema';
import { errorDetails, errorMessage } from '@/utils/errors';

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
  interactiveInputEnabled: false,
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
  form.interactiveInputEnabled = template.interactiveInputEnabled;
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
  return `${agent.name}（${agent.enabled ? (agent.status === 'ONLINE' ? '在线' : '离线') : '已停用'}）`;
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
    interactiveInputEnabled: form.interactiveInputEnabled,
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
  <section class="page-section template-editor-page">
    <div class="page-heading">
      <div>
        <h1>{{ title }}</h1>
        <p>配置模板基础参数、执行节点、构建命令与动态表单契约。</p>
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

    <el-form v-else :model="form" label-position="top" class="template-form" @submit.prevent="save">
      <el-card shadow="never" class="editor-section-card">
        <template #header>
          <div class="card-section-title">1. 基本信息与执行节点</div>
        </template>
        <div class="form-grid">
          <el-form-item label="模板名称" required>
            <el-input
              v-model="form.name"
              maxlength="120"
              placeholder="例如 Web 前端标准构建"
              show-word-limit
            />
          </el-form-item>
          <el-form-item label="绑定 Agent 节点" required>
            <el-select
              v-model="form.agentId"
              filterable
              class="full-width"
              placeholder="请选择构建机节点"
            >
              <el-option
                v-for="agent in enabledAgents"
                :key="agent.id"
                :label="displayAgent(agent)"
                :value="agent.id"
                :disabled="isAgentDisabled(agent)"
              >
                <span>{{ displayAgent(agent) }}</span>
                <small v-if="agent.enabled && agent.status === 'OFFLINE'" class="option-hint">
                  （当前离线，仍可绑定）
                </small>
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="Git 仓库 URL" required>
            <el-input
              v-model="form.gitUrl"
              placeholder="https://github.com/user/repo.git 或 git@..."
            />
          </el-form-item>
          <el-form-item label="产物收集目录" required>
            <el-input v-model="form.artifactDir" placeholder="例如 dist 或 target/release" />
          </el-form-item>
        </div>
        <el-form-item label="模板说明">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="2"
            maxlength="1000"
            show-word-limit
            placeholder="描述此构建模板的适用场景与构建目标"
          />
        </el-form-item>
      </el-card>

      <el-card shadow="never" class="editor-section-card">
        <template #header>
          <div class="card-section-title">2. 执行命令与超时设定</div>
        </template>
        <el-form-item label="构建命令" required>
          <el-input
            v-model="form.command"
            type="textarea"
            :rows="5"
            spellcheck="false"
            class="command-input"
            placeholder="例如: pnpm install && pnpm build"
          />
          <div class="form-help">
            Agent 将在仓库根目录下执行此命令；命令退出码为 0 视为构建成功。
          </div>
        </el-form-item>
        <el-form-item label="超时时间（秒）" required>
          <el-input-number v-model="form.timeoutSeconds" :min="1" :max="86400" :step="60" />
          <span class="muted-text" style="margin-left: 12px">
            约 {{ Math.round(form.timeoutSeconds / 60) }} 分钟
          </span>
        </el-form-item>
        <el-form-item label="构建期间交互输入">
          <el-switch v-model="form.interactiveInputEnabled" />
          <div class="form-help">
            启用后，任务详情页可在构建命令等待 stdin 时发送一行文本；输入不会持久化。
          </div>
        </el-form-item>
      </el-card>

      <el-card shadow="never" class="editor-section-card">
        <template #header>
          <div class="card-section-title">3. 动态表单契约 (formSchema)</div>
        </template>
        <div class="schema-tip">
          表单协议只在浏览器本地解析和预览，保存时提交校验后的 JSON。支持 9 种标准白名单控件。
        </div>
        <el-form-item label="formSchema JSON" required>
          <FormSchemaEditor
            v-model="form.formSchema"
            :external-issues="serverSchemaIssues"
            @validation="onSchemaValidation"
            @schema-change="clearServerSchemaIssues"
          />
        </el-form-item>
      </el-card>

      <div class="form-actions">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="saving" native-type="submit">
          {{ editing ? '保存模板' : '创建模板' }}
        </el-button>
      </div>
    </el-form>
  </section>
</template>

<style scoped>
.template-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.editor-section-card {
  border-radius: var(--ar-radius-lg);
}

.card-section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ar-text-primary);
}

.command-input :deep(textarea) {
  font-family: var(--ar-font-mono);
  background-color: var(--ar-bg-terminal);
  color: #f1f5f9;
  font-size: 13px;
  line-height: 1.5;
}

.schema-tip {
  font-size: 13px;
  color: var(--ar-text-secondary);
  margin-bottom: 12px;
}
</style>
