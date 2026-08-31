<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';

import * as projectApi from '@/api/project';
import * as taskApi from '@/api/tasks';
import type { ProjectView } from '@/api/types';
import { errorMessage } from '@/utils/errors';
import {
  agentStatusLabel,
  agentStatusType,
  compatibilityLabel,
  compatibilityType,
  formatDate,
} from './project-status';

const route = useRoute();
const router = useRouter();
const project = ref<ProjectView | null>(null);
const loading = ref(false);
const error = ref('');
const creatingTask = ref(false);

function projectId(): string {
  const value = route.params.projectId;
  return typeof value === 'string' ? value : '';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    project.value = (await projectApi.getProject(projectId())).project;
  } catch (caught) {
    error.value = errorMessage(caught, '项目详情加载失败');
  } finally {
    loading.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  if (!project.value) return;
  try {
    await ElMessageBox.confirm(
      `确定软删除项目“${project.value.name}”吗？删除后将无法从项目列表访问。`,
      '确认删除项目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
    await projectApi.deleteProject(project.value.id);
    ElMessage.success('项目已删除');
    await router.replace({ name: 'projects' });
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') ElMessage.error(errorMessage(caught));
  }
}

async function startBuild(): Promise<void> {
  if (!project.value || !project.value.configCompatibility.buildable || creatingTask.value) return;
  try {
    await ElMessageBox.confirm(
      `将使用项目当前分支“${project.value.branch}”、配置和模板开始构建，是否继续？`,
      '确认开始构建',
      { type: 'warning', confirmButtonText: '开始构建', cancelButtonText: '取消' },
    );
    creatingTask.value = true;
    const result = await taskApi.createTask(project.value.id);
    await router.push({ name: 'task-detail', params: { taskId: result.task.id } });
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close')
      ElMessage.error(errorMessage(caught, '任务创建失败'));
  } finally {
    creatingTask.value = false;
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
        <h1>项目详情</h1>
        <p>查看项目所有权、模板和动态配置兼容状态。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="router.push({ name: 'projects' })">返回列表</el-button>
        <el-button
          v-if="project"
          @click="router.push({ name: 'project-edit', params: { projectId: project.id } })"
          >编辑基本信息</el-button
        >
        <el-button
          v-if="project"
          type="primary"
          @click="router.push({ name: 'project-config', params: { projectId: project.id } })"
          >编辑配置</el-button
        >
        <el-button
          v-if="project"
          type="success"
          :loading="creatingTask"
          :disabled="!project.configCompatibility.buildable"
          :title="
            project.configCompatibility.buildable
              ? '使用项目当前分支、配置和模板开始构建'
              : '当前项目不可构建，请先修正配置或启用模板/Agent'
          "
          @click="startBuild"
          >开始构建</el-button
        >
        <el-button
          v-if="project"
          @click="router.push({ name: 'project-tasks', params: { projectId: project.id } })"
          >构建记录</el-button
        >
        <el-button v-if="project" type="danger" plain @click="confirmDelete">删除</el-button>
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
      <el-card shadow="never">
        <div class="detail-grid">
          <div>
            <span class="detail-label">项目名称</span><strong>{{ project.name }}</strong>
          </div>
          <div>
            <span class="detail-label">Git 分支</span><code>{{ project.branch }}</code>
          </div>
          <div>
            <span class="detail-label">所有者</span>{{ project.owner.username }}（{{
              project.owner.role
            }}）
          </div>
          <div><span class="detail-label">更新时间</span>{{ formatDate(project.updatedAt) }}</div>
          <div class="detail-grid__wide">
            <span class="detail-label">项目说明</span>{{ project.description || '暂无说明' }}
          </div>
        </div>
      </el-card>

      <el-card shadow="never">
        <template #header><span>模板与执行节点</span></template>
        <div class="detail-grid">
          <div><span class="detail-label">构建模板</span>{{ project.buildTemplate.name }}</div>
          <div>
            <span class="detail-label">模板状态</span>
            <el-tag :type="project.buildTemplate.enabled ? 'success' : 'danger'">
              {{ project.buildTemplate.enabled ? '已启用' : '已停用' }}
            </el-tag>
          </div>
          <div><span class="detail-label">Agent</span>{{ project.buildTemplate.agent.name }}</div>
          <div>
            <span class="detail-label">Agent 状态</span>
            <el-tag :type="agentStatusType(project.buildTemplate.agent)">
              {{ agentStatusLabel(project.buildTemplate.agent) }}
            </el-tag>
          </div>
        </div>
      </el-card>

      <el-card shadow="never">
        <template #header><span>配置兼容性</span></template>
        <div class="status-line">
          <el-tag :type="compatibilityType(project)">
            {{ compatibilityLabel(project) }}
          </el-tag>
          <span
            >当前配置字段
            {{ Object.keys(project.configCompatibility.effectiveConfig).length }} 个</span
          >
        </div>
        <el-alert
          v-if="!project.configCompatibility.valid"
          title="模板变化后配置需要调整"
          type="warning"
          :closable="false"
          class="page-alert"
        />
        <el-alert
          v-else-if="!project.configCompatibility.buildable"
          title="项目当前不可构建：模板或 Agent 已停用"
          type="warning"
          :closable="false"
          class="page-alert"
        />
        <div v-if="project.configCompatibility.missingFields.length" class="compatibility-block">
          <strong>缺少必填字段：</strong>{{ project.configCompatibility.missingFields.join('、') }}
        </div>
        <div v-if="project.configCompatibility.obsoleteFields.length" class="compatibility-block">
          <strong>已废弃字段：</strong>{{ project.configCompatibility.obsoleteFields.join('、') }}
        </div>
        <div
          v-if="project.configCompatibility.typeConflictFields.length"
          class="compatibility-block"
        >
          <strong>类型冲突字段：</strong
          >{{ project.configCompatibility.typeConflictFields.join('、') }}
        </div>
        <ul v-if="project.configCompatibility.issues.length" class="issue-list">
          <li
            v-for="issue in project.configCompatibility.issues"
            :key="`${issue.code}-${issue.pointer}-${issue.message}`"
          >
            {{ issue.message }}（{{ issue.pointer || '(root)' }}）
          </li>
        </ul>
        <p v-if="project.configCompatibility.buildable" class="muted-text">
          可以使用项目当前分支、配置和模板创建构建任务。
        </p>
      </el-card>
    </template>
  </section>
</template>
