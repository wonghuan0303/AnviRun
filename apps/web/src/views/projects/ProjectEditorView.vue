<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import {
  analyzeFormConfigCompatibility,
  normalizeFormConfigValues,
  validateFormConfigValues,
  type FormConfigIssue,
  type FormConfigValues,
  type FormSchema,
} from '@anvilrun/contracts';

import * as projectApi from '@/api/project';
import * as templateApi from '@/api/build-templates';
import type { BuildTemplatePublicView, ProjectView } from '@/api/types';
import FormConfigEditor from '@/form-schema/FormConfigEditor.vue';
import { removeIssuesForField } from '@/form-schema/config-issues';
import { errorMessage, formConfigIssues } from '@/utils/errors';

const route = useRoute();
const router = useRouter();
const projectId = computed(() => {
  const value = route.params.projectId;
  return typeof value === 'string' ? value : '';
});
const editing = computed(() => projectId.value.length > 0);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const templates = ref<BuildTemplatePublicView[]>([]);
const project = ref<ProjectView | null>(null);
const schema = ref<FormSchema>([]);
const config = ref<FormConfigValues>({});
const localIssues = ref<readonly FormConfigIssue[]>([]);
const serverIssues = ref<readonly FormConfigIssue[]>([]);
const form = reactive({
  name: '',
  description: '',
  branch: '',
  buildTemplateId: '',
});

const selectedTemplate = computed(() =>
  templates.value.find((template) => template.id === form.buildTemplateId),
);
const currentTemplateName = computed(
  () => project.value?.buildTemplate.name ?? selectedTemplate.value?.name ?? '未选择模板',
);
const currentAgent = computed(
  () => project.value?.buildTemplate.agent ?? selectedTemplate.value?.agent,
);

function setProject(value: ProjectView): void {
  project.value = value;
  form.name = value.name;
  form.description = value.description ?? '';
  form.branch = value.branch;
  form.buildTemplateId = value.buildTemplateId;
  schema.value = value.buildTemplate.formSchema ?? [];
  config.value = value.configCompatibility.effectiveConfig;
  serverIssues.value = value.configCompatibility.issues;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const templatePage = await templateApi.listPublicBuildTemplates({ page: 1, pageSize: 100 });
    templates.value = templatePage.items;
    if (editing.value) {
      const result = await projectApi.getProject(projectId.value);
      setProject(result.project);
    }
  } catch (caught) {
    error.value = errorMessage(caught, '项目编辑数据加载失败');
  } finally {
    loading.value = false;
  }
}

function selectTemplate(templateId: string): void {
  if (editing.value) return;
  form.buildTemplateId = templateId;
  const template = templates.value.find((item) => item.id === templateId);
  schema.value = template?.formSchema ?? [];
  config.value = analyzeFormConfigCompatibility(schema.value, {}).effectiveConfig;
  localIssues.value = [];
  serverIssues.value = [];
}

function onConfigValidation(issues: readonly FormConfigIssue[]): void {
  localIssues.value = issues;
}

function onConfigFieldChange(fieldName: string): void {
  serverIssues.value = removeIssuesForField(serverIssues.value, fieldName);
}

function validateBasicFields(): boolean {
  if (!form.name.trim()) {
    error.value = '请输入项目名称';
    return false;
  }
  if (!form.buildTemplateId) {
    error.value = '请选择构建模板';
    return false;
  }
  if (!form.branch.trim()) {
    error.value = '请输入 Git 分支';
    return false;
  }
  return true;
}

async function save(): Promise<void> {
  error.value = '';
  if (!validateBasicFields()) return;

  if (!editing.value) {
    const validation = validateFormConfigValues(schema.value, config.value);
    localIssues.value = validation.ok ? [] : validation.issues;
    if (!validation.ok) {
      error.value = '请修正配置后再保存';
      return;
    }
  }

  saving.value = true;
  try {
    if (editing.value) {
      const result = await projectApi.updateProject(projectId.value, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        branch: form.branch.trim(),
      });
      setProject(result.project);
      ElMessage.success('项目基本信息已保存');
      await router.replace({ name: 'project-detail', params: { projectId: projectId.value } });
    } else {
      const normalized = normalizeFormConfigValues(schema.value, config.value);
      const result = await projectApi.createProject({
        name: form.name.trim(),
        description: form.description.trim() || null,
        buildTemplateId: form.buildTemplateId,
        branch: form.branch.trim(),
        config: normalized,
      });
      ElMessage.success('项目创建成功');
      await router.replace({ name: 'project-detail', params: { projectId: result.project.id } });
    }
  } catch (caught) {
    const issues = formConfigIssues(caught);
    if (issues.length > 0) serverIssues.value = issues;
    error.value = errorMessage(caught, '项目保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="page-section project-editor-page">
    <div class="page-heading">
      <div>
        <h1>{{ editing ? '编辑项目' : '新建项目' }}</h1>
        <p>
          {{
            editing
              ? '修改项目基本信息，配置请使用独立页面保存。'
              : '创建项目并使用模板当前的动态配置。'
          }}
        </p>
      </div>
      <el-button @click="router.back()">返回</el-button>
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
    <el-form v-else :model="form" label-position="top" class="project-form" @submit.prevent="save">
      <el-card shadow="never" class="editor-section-card">
        <template #header>
          <div class="card-section-title">1. 基本信息</div>
        </template>
        <div class="form-grid">
          <el-form-item label="项目名称" required>
            <el-input
              v-model="form.name"
              maxlength="128"
              show-word-limit
              placeholder="例如 my-app-service"
            />
          </el-form-item>
          <el-form-item label="Git 分支" required>
            <el-input
              v-model="form.branch"
              maxlength="512"
              placeholder="例如 main 或 release/1.0"
            />
          </el-form-item>
        </div>

        <el-form-item label="项目说明">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="3"
            maxlength="4096"
            show-word-limit
            placeholder="填写项目简要介绍与用途"
          />
        </el-form-item>

        <el-form-item label="构建模板" required>
          <el-select
            v-if="!editing"
            v-model="form.buildTemplateId"
            class="full-width"
            filterable
            placeholder="请选择已启用模板"
            @change="selectTemplate"
          >
            <el-option
              v-for="template in templates"
              :key="template.id"
              :label="template.name"
              :value="template.id"
            >
              <span>{{ template.name }}</span>
              <span class="option-secondary">
                {{ template.agent.name }} ·
                {{ template.agent.status === 'ONLINE' ? '在线' : '离线' }}
              </span>
            </el-option>
          </el-select>
          <el-input v-else :model-value="currentTemplateName" disabled class="full-width" />
          <div v-if="currentTemplateName !== '未选择模板'" class="form-help">
            当前绑定模板：<strong>{{ currentTemplateName }}</strong>
            <span v-if="currentAgent && currentAgent.status !== 'ONLINE'">
              （Agent 当前离线，仍可保存项目）
            </span>
          </div>
        </el-form-item>
      </el-card>

      <el-card v-if="!editing" shadow="never" class="editor-section-card project-config-card">
        <template #header>
          <div class="card-section-title">2. 模板动态参数配置</div>
        </template>
        <el-alert
          v-if="schema.length === 0 && form.buildTemplateId"
          title="当前模板没有配置项，保存后配置为 {}"
          type="info"
          :closable="false"
        />
        <FormConfigEditor
          v-else-if="form.buildTemplateId"
          v-model="config"
          :schema="schema"
          :external-issues="serverIssues"
          @validation="onConfigValidation"
          @field-change="onConfigFieldChange"
        />
        <el-empty v-else description="请先选择构建模板以加载动态配置参数" />
      </el-card>

      <el-alert
        v-if="editing"
        title="项目配置不会通过基本信息保存，请进入“项目配置”页面修改。"
        type="info"
        :closable="false"
      />

      <div class="form-actions">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="saving" native-type="submit">
          {{ editing ? '保存基本信息' : '创建项目' }}
        </el-button>
      </div>
    </el-form>
  </section>
</template>

<style scoped>
.project-form {
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
</style>
