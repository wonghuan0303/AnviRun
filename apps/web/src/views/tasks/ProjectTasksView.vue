<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';

import * as projectApi from '@/api/project';
import * as taskApi from '@/api/tasks';
import type { ProjectView, TaskSummary } from '@/api/types';
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
  <section class="page-section">
    <div class="page-heading">
      <div>
        <h1>构建记录</h1>
        <p v-if="project">项目：{{ project.name }}</p>
        <p v-else>查看项目的构建任务与执行结果。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="router.push({ name: 'project-detail', params: { projectId } })"
          >返回项目</el-button
        >
        <el-button :loading="loading" @click="loadCurrent">刷新</el-button>
        <el-button
          type="primary"
          :loading="creating"
          :disabled="!canCreate"
          :title="canCreate ? '使用项目当前配置开始构建' : '项目当前不可构建'"
          @click="startBuild"
          >开始构建</el-button
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

    <el-card shadow="never">
      <el-form inline>
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
        <el-table-column label="任务 ID" min-width="140">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              @click="router.push({ name: 'task-detail', params: { taskId: row.id } })"
            >
              {{ shortTaskId(row.id) }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }"
            ><el-tag :type="taskStatusType(row.status)">{{
              taskStatusLabel(row.status)
            }}</el-tag></template
          >
        </el-table-column>
        <el-table-column prop="branch" label="分支" min-width="140" />
        <el-table-column label="Agent" min-width="150">
          <template #default="{ row }">
            {{ row.agent.name }}
            <span class="muted-text"
              >（{{
                row.agent.status === 'ONLINE' ? '在线' : row.agent.enabled ? '离线' : '已停用'
              }}）</span
            >
          </template>
        </el-table-column>
        <el-table-column label="Commit SHA" min-width="140">
          <template #default="{ row }">{{ row.sourceCommit || '—' }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="175"
          ><template #default="{ row }">{{
            formatTaskDate(row.createdAt)
          }}</template></el-table-column
        >
        <el-table-column label="排队时间" width="175"
          ><template #default="{ row }">{{
            formatTaskDate(row.queuedAt)
          }}</template></el-table-column
        >
        <el-table-column label="完成时间" width="175"
          ><template #default="{ row }">{{
            formatTaskDate(row.finishedAt)
          }}</template></el-table-column
        >
        <el-table-column label="产物" width="160"
          ><template #default="{ row }"
            >{{ row.artifactCount }} 个 / {{ formatBytes(row.artifactBytes) }}</template
          ></el-table-column
        >
        <el-table-column label="原因" min-width="200"
          ><template #default="{ row }">{{ row.statusReason || '—' }}</template></el-table-column
        >
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
