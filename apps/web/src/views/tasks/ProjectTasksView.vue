<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';

import * as projectApi from '@/api/project';
import * as taskApi from '@/api/tasks';
import type { ProjectView, TaskSummary } from '@/api/types';
import CopyableText from '@/components/CopyableText.vue';
import MetricCard from '@/components/MetricCard.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { errorMessage } from '@/utils/errors';
import {
  formatBytes,
  formatTaskDate,
  shortTaskId,
  TASK_STATUSES,
  taskStatusLabel,
  taskStatusType,
} from './task-status';

const route = useRoute();
const router = useRouter();
const project = ref<ProjectView | null>(null);
const items = ref<TaskSummary[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const status = ref('');
const loading = ref(false);
const creating = ref(false);
const error = ref('');
let contextGeneration = 0;
let destroyed = false;

const projectId = computed(() => {
  const value = route.params.projectId;
  return typeof value === 'string' ? value : '';
});
const canCreate = computed(() => project.value?.configCompatibility.buildable === true);

const runningCount = computed(
  () =>
    items.value.filter((t) =>
      ['DISPATCHED', 'PREPARING', 'RUNNING', 'UPLOADING'].includes(t.status),
    ).length,
);
const successCount = computed(() => items.value.filter((t) => t.status === 'SUCCEEDED').length);
const failedCount = computed(
  () => items.value.filter((t) => ['FAILED', 'AGENT_LOST'].includes(t.status)).length,
);

function isCurrentContext(generation: number, expectedProjectId: string): boolean {
  return !destroyed && generation === contextGeneration && projectId.value === expectedProjectId;
}

async function loadProject(
  generation = contextGeneration,
  expectedProjectId = projectId.value,
): Promise<void> {
  if (!isCurrentContext(generation, expectedProjectId)) return;
  try {
    const result = await projectApi.getProject(expectedProjectId);
    if (isCurrentContext(generation, expectedProjectId)) project.value = result.project;
  } catch (caught) {
    if (isCurrentContext(generation, expectedProjectId))
      error.value = errorMessage(caught, '项目详情加载失败');
  }
}

async function load(
  generation = contextGeneration,
  expectedProjectId = projectId.value,
): Promise<void> {
  if (!isCurrentContext(generation, expectedProjectId)) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await taskApi.listProjectTasks(expectedProjectId, {
      page: page.value,
      pageSize: pageSize.value,
      status: status.value ? (status.value as TaskSummary['status']) : undefined,
    });
    if (isCurrentContext(generation, expectedProjectId)) {
      items.value = result.items;
      total.value = result.total;
    }
  } catch (caught) {
    if (isCurrentContext(generation, expectedProjectId))
      error.value = errorMessage(caught, '任务列表加载失败');
  } finally {
    if (isCurrentContext(generation, expectedProjectId)) loading.value = false;
  }
}

async function startBuild(): Promise<void> {
  if (!canCreate.value || creating.value) return;
  const generation = contextGeneration;
  const expectedProjectId = projectId.value;
  try {
    await ElMessageBox.confirm(
      `将使用项目当前分支“${project.value?.branch ?? ''}”、配置和模板开始构建，是否继续？`,
      '确认开始构建',
      { type: 'warning', confirmButtonText: '开始构建', cancelButtonText: '取消' },
    );
    creating.value = true;
    const result = await taskApi.createTask(expectedProjectId);
    if (!isCurrentContext(generation, expectedProjectId)) return;
    await router.push({ name: 'task-detail', params: { taskId: result.task.id } });
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close')
      ElMessage.error(errorMessage(caught, '任务创建失败'));
  } finally {
    creating.value = false;
  }
}

function resetProjectContext(): number {
  const generation = ++contextGeneration;
  project.value = null;
  items.value = [];
  total.value = 0;
  page.value = 1;
  error.value = '';
  creating.value = false;
  return generation;
}

function loadProjectContext(): void {
  if (destroyed) return;
  const generation = resetProjectContext();
  const expectedProjectId = projectId.value;
  void Promise.all([
    loadProject(generation, expectedProjectId),
    load(generation, expectedProjectId),
  ]);
}

function loadCurrent(): void {
  void load(contextGeneration, projectId.value);
}

function isTaskActive(taskStatus: TaskSummary['status']): boolean {
  return ['DISPATCHED', 'PREPARING', 'RUNNING', 'UPLOADING'].includes(taskStatus);
}

onMounted(() => {
  void loadProjectContext();
});

watch(projectId, (next, previous) => {
  if (next !== previous) loadProjectContext();
});

onBeforeUnmount(() => {
  destroyed = true;
  contextGeneration += 1;
});
</script>

<template>
  <section class="page-section project-tasks-page">
    <div class="page-heading">
      <div>
        <div class="breadcrumb-nav">
          <el-button
            link
            type="primary"
            class="back-link"
            @click="router.push({ name: 'project-detail', params: { projectId } })"
          >
            ← 返回项目详情
          </el-button>
        </div>
        <h1>构建记录</h1>
        <p v-if="project">项目：{{ project.name }}</p>
        <p v-else>查看项目的构建历史、状态演变与输出产物。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="router.push({ name: 'project-detail', params: { projectId } })">
          返回项目
        </el-button>
        <el-button :loading="loading" @click="loadCurrent">刷新</el-button>
        <el-button
          type="primary"
          :loading="creating"
          :disabled="!canCreate"
          :title="canCreate ? '使用项目当前配置开始构建' : '项目当前不可构建'"
          @click="startBuild"
        >
          开始构建
        </el-button>
      </div>
    </div>

    <div class="task-stats-grid">
      <MetricCard label="总构建次数" :value="total" hint="累计触发构建" />
      <MetricCard label="进行中任务" :value="runningCount" type="primary" hint="当前打包队列" />
      <MetricCard label="构建成功" :value="successCount" type="success" hint="正常完成" />
      <MetricCard label="构建失败" :value="failedCount" type="danger" hint="错误或失联" />
    </div>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    />

    <el-card shadow="never" class="filter-card">
      <el-form
        inline
        @submit.prevent="
          page = 1;
          loadCurrent();
        "
      >
        <el-form-item label="状态">
          <el-select
            v-model="status"
            clearable
            placeholder="全部状态"
            style="width: 180px"
            @change="
              page = 1;
              loadCurrent();
            "
          >
            <el-option
              v-for="item in TASK_STATUSES"
              :key="item"
              :value="item"
              :label="taskStatusLabel(item)"
            />
          </el-select>
        </el-form-item>
        <el-button
          @click="
            page = 1;
            loadCurrent();
          "
          >应用筛选</el-button
        >
      </el-form>
    </el-card>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="items" row-key="id">
        <el-table-column label="任务 ID" min-width="150">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              class="task-id-link"
              @click="router.push({ name: 'task-detail', params: { taskId: row.id } })"
            >
              {{ shortTaskId(row.id) }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <StatusBadge
              :type="taskStatusType(row.status)"
              :text="taskStatusLabel(row.status)"
              :pulse="isTaskActive(row.status)"
            />
          </template>
        </el-table-column>
        <el-table-column prop="branch" label="分支" min-width="140">
          <template #default="{ row }">
            <code class="branch-code">{{ row.branch }}</code>
          </template>
        </el-table-column>
        <el-table-column label="Agent" min-width="160">
          <template #default="{ row }">
            <span class="agent-info">{{ row.agent.name }}</span>
            <span class="muted-text">
              （{{
                row.agent.status === 'ONLINE' ? '在线' : row.agent.enabled ? '离线' : '已停用'
              }}）
            </span>
          </template>
        </el-table-column>
        <el-table-column label="Commit SHA" min-width="150">
          <template #default="{ row }">
            <CopyableText
              v-if="row.sourceCommit"
              :text="row.sourceCommit"
              :display-text="row.sourceCommit.slice(0, 7)"
            />
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="175">
          <template #default="{ row }">{{ formatTaskDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="排队时间" width="175">
          <template #default="{ row }">{{ formatTaskDate(row.queuedAt) }}</template>
        </el-table-column>
        <el-table-column label="完成时间" width="175">
          <template #default="{ row }">{{ formatTaskDate(row.finishedAt) }}</template>
        </el-table-column>
        <el-table-column label="产物" width="160">
          <template #default="{ row }">
            <span class="artifact-stat">
              {{ row.artifactCount }} 个 / {{ formatBytes(row.artifactBytes) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="原因" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.statusReason || '—' }}</template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && items.length === 0" description="暂无构建任务" />

      <div class="pagination-row">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          layout="total, sizes, prev, pager, next"
          :total="total"
          @current-change="loadCurrent"
          @size-change="loadCurrent"
        />
      </div>
    </el-card>
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

.task-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.filter-card {
  border-radius: var(--ar-radius-lg);
}

.task-id-link {
  font-family: var(--ar-font-mono);
  font-weight: 600;
}

.branch-code {
  background: var(--ar-bg-subtle);
  padding: 2px 6px;
  border-radius: var(--ar-radius-sm);
  color: var(--ar-color-slate-700);
  font-size: 12px;
}

.artifact-stat {
  font-size: 13px;
  color: var(--ar-text-regular);
}
</style>
