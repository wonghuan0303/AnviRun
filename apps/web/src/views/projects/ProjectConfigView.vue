<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import {
  normalizeFormConfigValues,
  validateFormConfigValues,
  type FormConfigIssue,
  type FormConfigValues,
  type FormSchema,
} from '@anvilrun/contracts';

import * as projectApi from '@/api/project';
import type { ProjectView } from '@/api/types';
import { errorMessage, formConfigIssues } from '@/utils/errors';
import FormConfigEditor from '@/form-schema/FormConfigEditor.vue';
import { removeIssuesForField } from '@/form-schema/config-issues';
import { agentStatusLabel, agentStatusType } from './project-status';

const route = useRoute();
const router = useRouter();
const project = ref<ProjectView | null>(null);
const schema = ref<FormSchema>([]);
const config = ref<FormConfigValues>({});
const localIssues = ref<readonly FormConfigIssue[]>([]);
const serverIssues = ref<readonly FormConfigIssue[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');

function projectId(): string {
  const value = route.params.projectId;
  return typeof value === 'string' ? value : '';
}

function applyProject(value: ProjectView): void {
  project.value = value;
  schema.value = value.buildTemplate.formSchema ?? [];
  config.value = value.configCompatibility.effectiveConfig;
  serverIssues.value = value.configCompatibility.issues;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    applyProject((await projectApi.getProject(projectId())).project);
  } catch (caught) {
    error.value = errorMessage(caught, '项目配置加载失败');
  } finally {
    loading.value = false;
  }
}

function onValidation(issues: readonly FormConfigIssue[]): void {
  localIssues.value = issues;
}

function onFieldChange(fieldName: string): void {
  serverIssues.value = removeIssuesForField(serverIssues.value, fieldName);
}

async function save(): Promise<void> {
  error.value = '';
  serverIssues.value = [];
  const validation = validateFormConfigValues(schema.value, config.value);
  localIssues.value = validation.ok ? [] : validation.issues;
  if (!validation.ok) {
    error.value = '请修正配置后再保存';
    return;
  }

  saving.value = true;
  try {
    const normalized = normalizeFormConfigValues(schema.value, config.value);
    const result = await projectApi.saveProjectConfig(projectId(), normalized);
    applyProject(result.project);
    localIssues.value = [];
    ElMessage.success('项目配置已保存');
  } catch (caught) {
    const issues = formConfigIssues(caught);
    if (issues.length > 0) serverIssues.value = issues;
    error.value = errorMessage(caught, '项目配置保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="page-section project-config-page">
    <div class="page-heading">
      <div>
        <h1>项目配置</h1>
        <p v-if="project">使用“{{ project.buildTemplate.name }}”的当前表单 Schema 填写配置。</p>
      </div>
      <div class="page-heading__actions">
        <el-button
          @click="router.push({ name: 'project-detail', params: { projectId: projectId() } })"
          >返回详情</el-button
        >
        <el-button type="primary" :loading="saving" :disabled="loading" @click="save"
          >保存配置</el-button
        >
      </div>
    </div>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    />
    <el-skeleton v-if="loading" :rows="10" animated />

    <template v-else-if="project">
      <el-card shadow="never" class="project-config-card">
        <div class="status-line">
          <span>Agent：{{ project.buildTemplate.agent.name }}</span>
          <el-tag :type="agentStatusType(project.buildTemplate.agent)">
            {{ agentStatusLabel(project.buildTemplate.agent) }}
          </el-tag>
          <el-tag v-if="!project.buildTemplate.enabled" type="danger">模板已停用</el-tag>
        </div>
        <el-alert
          v-if="!project.configCompatibility.valid"
          title="当前已保存配置与模板不兼容，请根据字段提示修正。"
          type="warning"
          :closable="false"
          class="page-alert"
        />
        <el-alert
          v-else-if="!project.configCompatibility.buildable"
          title="配置有效，但模板或 Agent 当前不可用；保存不受影响。"
          type="info"
          :closable="false"
          class="page-alert"
        />
        <FormConfigEditor
          v-model="config"
          :schema="schema"
          :external-issues="serverIssues"
          @validation="onValidation"
          @field-change="onFieldChange"
        />
      </el-card>
    </template>
  </section>
</template>
