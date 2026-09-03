<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';

import * as projectApi from '@/api/project';
import * as taskApi from '@/api/tasks';
import type { ProjectView } from '@/api/types';
import CopyableText from '@/components/CopyableText.vue';
import StatusBadge from '@/components/StatusBadge.vue';
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
  <section class="page-section project-detail-page">
    <div class="page-heading">
      <div>
        <div class="breadcrumb-nav">
          <el-button
            link
            type="primary"
            class="back-link"
            @click="router.push({ name: 'projects' })"
          >
            ← 返回项目列表
          </el-button>
        </div>
        <div class="title-with-badge">
          <h1>{{ project?.name || '项目详情' }}</h1>
          <StatusBadge
            v-if="project"
            :type="compatibilityType(project)"
            :text="compatibilityLabel(project)"
          />
        </div>
        <p>查看项目配置、绑定的构建模板与执行节点兼容性诊断。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="router.push({ name: 'projects' })">返回列表</el-button>
        <el-button
          v-if="project"
          @click="router.push({ name: 'project-edit', params: { projectId: project.id } })"
        >
          编辑基本信息
        </el-button>
        <el-button
          v-if="project"
          type="primary"
          plain
          @click="router.push({ name: 'project-config', params: { projectId: project.id } })"
        >
          编辑配置
        </el-button>
        <el-button
          v-if="project"
          type="primary"
          :loading="creatingTask"
          :disabled="!project.configCompatibility.buildable"
          :title="
            project.configCompatibility.buildable
              ? '使用项目当前分支、配置和模板开始构建'
              : '当前项目不可构建，请先修正配置或启用模板/Agent'
          "
          @click="startBuild"
        >
          开始构建
        </el-button>
        <el-button
          v-if="project"
          @click="router.push({ name: 'project-tasks', params: { projectId: project.id } })"
        >
          构建记录
        </el-button>
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
      <div class="detail-sections">
        <!-- 基础信息卡片 -->
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="card-header-line">
              <span class="card-title">基本信息</span>
              <span class="muted-text">更新时间：{{ formatDate(project.updatedAt) }}</span>
            </div>
          </template>
          <div class="detail-grid">
            <div>
              <span class="detail-label">项目名称</span>
              <strong>{{ project.name }}</strong>
            </div>
            <div>
              <span class="detail-label">Git 分支</span>
              <CopyableText :text="project.branch" />
            </div>
            <div>
              <span class="detail-label">所有者</span>
              <span>{{ project.owner.username }}（{{ project.owner.role }}）</span>
            </div>
            <div>
              <span class="detail-label">更新时间</span>
              <span>{{ formatDate(project.updatedAt) }}</span>
            </div>
            <div class="detail-grid__wide">
              <span class="detail-label">项目说明</span>
              <div class="description-box">{{ project.description || '暂无说明' }}</div>
            </div>
          </div>
        </el-card>

        <!-- 模板与执行节点 -->
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="card-header-line">
              <span class="card-title">模板与执行节点</span>
            </div>
          </template>
          <div class="detail-grid">
            <div>
              <span class="detail-label">构建模板</span>
              <strong>{{ project.buildTemplate.name }}</strong>
            </div>
            <div>
              <span class="detail-label">模板状态</span>
              <el-tag :type="project.buildTemplate.enabled ? 'success' : 'danger'">
                {{ project.buildTemplate.enabled ? '已启用' : '已停用' }}
              </el-tag>
            </div>
            <div>
              <span class="detail-label">Agent 节点</span>
              <strong>{{ project.buildTemplate.agent.name }}</strong>
            </div>
            <div>
              <span class="detail-label">Agent 状态</span>
              <StatusBadge
                :type="agentStatusType(project.buildTemplate.agent)"
                :text="agentStatusLabel(project.buildTemplate.agent)"
                :pulse="
                  project.buildTemplate.agent.enabled &&
                  project.buildTemplate.agent.status === 'ONLINE'
                "
              />
            </div>
          </div>
        </el-card>

        <!-- 配置兼容性诊断 -->
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="card-header-line">
              <span class="card-title">配置兼容性诊断</span>
              <el-button
                link
                type="primary"
                @click="router.push({ name: 'project-config', params: { projectId: project.id } })"
              >
                前往编辑配置 →
              </el-button>
            </div>
          </template>
          <div class="status-line">
            <el-tag :type="compatibilityType(project)" size="large">
              {{ compatibilityLabel(project) }}
            </el-tag>
            <span class="muted-text">
              当前配置字段 {{ Object.keys(project.configCompatibility.effectiveConfig).length }} 个
            </span>
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

          <div
            v-if="project.configCompatibility.missingFields.length"
            class="compatibility-block danger-block"
          >
            <strong>缺少必填字段：</strong>
            <el-tag
              v-for="field in project.configCompatibility.missingFields"
              :key="field"
              type="danger"
              size="small"
              class="issue-tag"
            >
              {{ field }}
            </el-tag>
          </div>

          <div
            v-if="project.configCompatibility.obsoleteFields.length"
            class="compatibility-block warning-block"
          >
            <strong>已废弃字段：</strong>
            <el-tag
              v-for="field in project.configCompatibility.obsoleteFields"
              :key="field"
              type="info"
              size="small"
              class="issue-tag"
            >
              {{ field }}
            </el-tag>
          </div>

          <div
            v-if="project.configCompatibility.typeConflictFields.length"
            class="compatibility-block danger-block"
          >
            <strong>类型冲突字段：</strong>
            <el-tag
              v-for="field in project.configCompatibility.typeConflictFields"
              :key="field"
              type="danger"
              size="small"
              class="issue-tag"
            >
              {{ field }}
            </el-tag>
          </div>

          <ul v-if="project.configCompatibility.issues.length" class="issue-list">
            <li
              v-for="issue in project.configCompatibility.issues"
              :key="`${issue.code}-${issue.pointer}-${issue.message}`"
            >
              {{ issue.message }}（{{ issue.pointer || '(root)' }}）
            </li>
          </ul>

          <p v-if="project.configCompatibility.buildable" class="muted-text ready-hint">
            ✓ 可以使用项目当前分支、配置和模板创建构建任务。
          </p>
        </el-card>
      </div>
    </template>
  </section>
</template>

<style scoped>
.breadcrumb-nav {
  margin-bottom: 4px;
}

.back-link {
  font-size: 13px;
  padding: 0;
}

.title-with-badge {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.title-with-badge h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--ar-text-primary);
}

.detail-sections {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-card {
  border-radius: var(--ar-radius-lg);
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ar-text-primary);
}

.description-box {
  background: var(--ar-bg-subtle);
  padding: 10px 14px;
  border-radius: var(--ar-radius-md);
  font-size: 13px;
  color: var(--ar-text-regular);
  line-height: 1.5;
}

.danger-block,
.warning-block {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-radius: var(--ar-radius-md);
  margin: 10px 0;
}

.danger-block {
  background: var(--ar-status-danger-bg);
  color: var(--ar-status-danger-text);
  border: 1px solid var(--ar-status-danger-border);
}

.warning-block {
  background: var(--ar-status-warning-bg);
  color: var(--ar-status-warning-text);
  border: 1px solid var(--ar-status-warning-border);
}

.issue-tag {
  margin-right: 4px;
}

.ready-hint {
  color: var(--ar-status-success-text);
  font-weight: 500;
  margin-top: 12px;
}
</style>
