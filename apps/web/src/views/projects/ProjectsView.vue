<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { VideoPlay } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';

import * as projectApi from '@/api/project';
import * as templateApi from '@/api/build-templates';
import * as taskApi from '@/api/tasks';
import type {
  BuildTaskStatus,
  BuildTemplatePublicView,
  ProjectView,
  TaskSummary,
} from '@/api/types';
import { formatTaskDate, shortTaskId, taskStatusLabel } from '@/views/tasks/task-status';
import MetricCard from '@/components/MetricCard.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/errors';
import {
  agentStatusLabel,
  agentStatusType,
  compatibilityLabel,
  compatibilityType,
  formatDate,
} from './project-status';

const auth = useAuthStore();
const router = useRouter();
const items = ref<ProjectView[]>([]);
const templates = ref<BuildTemplatePublicView[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const search = ref('');
const buildTemplateId = ref('');
const loading = ref(false);
const error = ref('');
const hasLoadedTemplates = ref(false);
const activeTasksByProjectId = ref<Record<string, TaskSummary[]>>({});
const activeTaskLoadingByProjectId = ref<Record<string, boolean>>({});
const startingProjectId = ref<string | null>(null);
const stoppingProjectId = ref<string | null>(null);
const stopDialogVisible = ref(false);
const stopDialogProjectId = ref<string | null>(null);
const selectedStopTaskId = ref('');
let activeTaskLoadGeneration = 0;
const isAdmin = computed(() => auth.isAdmin);

const stopDialogProject = computed(
  () => items.value.find((project) => project.id === stopDialogProjectId.value) ?? null,
);

const stopDialogTasks = computed(() =>
  stopDialogProjectId.value ? (activeTasksByProjectId.value[stopDialogProjectId.value] ?? []) : [],
);

const CANCELABLE_TASK_STATUSES: readonly BuildTaskStatus[] = [
  'CREATED',
  'WAITING_AGENT',
  'QUEUED',
  'DISPATCHED',
  'PREPARING',
  'RUNNING',
  'UPLOADING',
];

const buildableCount = computed(
  () => items.value.filter((p) => p.configCompatibility.buildable).length,
);
const incompatibleCount = computed(
  () => items.value.filter((p) => !p.configCompatibility.valid).length,
);

function toProject(value: unknown): ProjectView {
  return value as ProjectView;
}

function agentStatusDisplayText(project: ProjectView): string {
  return agentStatusLabel(project.buildTemplate.agent);
}

function compatibilityDisplayText(project: ProjectView): string {
  return compatibilityLabel(project);
}

async function loadTemplates(): Promise<void> {
  try {
    const result = await templateApi.listPublicBuildTemplates({ page: 1, pageSize: 100 });
    templates.value = result.items;
    hasLoadedTemplates.value = true;
  } catch (caught) {
    error.value = errorMessage(caught, '模板列表加载失败');
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await projectApi.listProjects({
      page: page.value,
      pageSize: pageSize.value,
      search: search.value.trim(),
      buildTemplateId: buildTemplateId.value || undefined,
    });
    items.value = result.items;
    total.value = result.total;
    void loadActiveTasks(result.items);
  } catch (caught) {
    error.value = errorMessage(caught, '项目列表加载失败');
  } finally {
    loading.value = false;
  }
}

function submitSearch(): void {
  page.value = 1;
  void load();
}

function templateName(project: ProjectView): string {
  return project.buildTemplate.name;
}

function isCancelableTask(task: TaskSummary): boolean {
  return CANCELABLE_TASK_STATUSES.includes(task.status);
}

function canStartBuild(project: ProjectView): boolean {
  return project.configCompatibility.buildable && startingProjectId.value === null;
}

function startBuildTitle(project: ProjectView): string {
  if (project.configCompatibility.buildable) return '开始构建';
  if (!project.configCompatibility.valid) return '配置无效，请先修正参数配置';
  if (!project.configCompatibility.templateEnabled) return '构建模板已停用';
  if (!project.configCompatibility.agentEnabled) return 'Agent 不可用，请先启用 Agent';
  return '当前项目不可构建';
}

function canStopBuild(project: ProjectView): boolean {
  const tasks = activeTasksByProjectId.value[project.id] ?? [];
  return (
    !activeTaskLoadingByProjectId.value[project.id] && tasks.some((task) => isCancelableTask(task))
  );
}

function stopBuildTitle(project: ProjectView): string {
  if (stoppingProjectId.value === project.id) return '正在停止构建';
  if (activeTaskLoadingByProjectId.value[project.id]) return '正在检查活动构建';
  return canStopBuild(project) ? '停止构建' : '当前没有可停止的构建';
}

async function loadActiveTasks(projects: readonly ProjectView[]): Promise<void> {
  const generation = ++activeTaskLoadGeneration;
  activeTasksByProjectId.value = {};
  activeTaskLoadingByProjectId.value = Object.fromEntries(
    projects.map((project) => [project.id, true]),
  );

  const results = await Promise.all(
    projects.map(async (project) => {
      try {
        const result = await taskApi.listProjectTasks(project.id, { page: 1, pageSize: 100 });
        const tasks = result.items.filter((item) => isCancelableTask(item));
        return { projectId: project.id, tasks };
      } catch {
        return { projectId: project.id, tasks: [] };
      }
    }),
  );
  if (generation !== activeTaskLoadGeneration) return;

  activeTasksByProjectId.value = Object.fromEntries(
    results.map(({ projectId, tasks }) => [projectId, tasks]),
  );
  activeTaskLoadingByProjectId.value = Object.fromEntries(
    projects.map((project) => [project.id, false]),
  );
}

async function startBuild(project: ProjectView): Promise<void> {
  if (!canStartBuild(project)) return;
  startingProjectId.value = project.id;
  try {
    await ElMessageBox.confirm(
      `将使用项目当前分支“${project.branch}”、配置和模板开始构建，是否继续？`,
      '确认开始构建',
      { type: 'warning', confirmButtonText: '开始构建', cancelButtonText: '取消' },
    );
    const result = await taskApi.createTask(project.id);
    await router.push({ name: 'task-detail', params: { taskId: result.task.id } });
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close')
      ElMessage.error(errorMessage(caught, '任务创建失败'));
  } finally {
    startingProjectId.value = null;
  }
}

function resetStopDialog(): void {
  stopDialogProjectId.value = null;
  selectedStopTaskId.value = '';
}

function openStopDialog(project: ProjectView): void {
  const tasks = activeTasksByProjectId.value[project.id] ?? [];
  if (!tasks.length || stoppingProjectId.value !== null) return;

  if (tasks.length === 1) {
    const [task] = tasks;
    if (task) void stopBuild(project, task);
    return;
  }

  stopDialogProjectId.value = project.id;
  selectedStopTaskId.value = '';
  stopDialogVisible.value = true;
}

async function confirmSelectedStopTask(): Promise<void> {
  const project = stopDialogProject.value;
  const task = stopDialogTasks.value.find((item) => item.id === selectedStopTaskId.value);
  if (!project || !task) return;

  stopDialogVisible.value = false;
  await stopBuild(project, task);
}

async function stopBuild(project: ProjectView, task: TaskSummary): Promise<void> {
  if (!isCancelableTask(task) || stoppingProjectId.value !== null) return;
  stoppingProjectId.value = project.id;
  try {
    await ElMessageBox.confirm(
      `确定停止项目“${project.name}”中的构建 ${shortTaskId(task.id)}（${taskStatusLabel(task.status)}）吗？`,
      '确认停止构建',
      {
        type: 'warning',
        confirmButtonText: '停止构建',
        cancelButtonText: '暂不操作',
      },
    );
    await taskApi.cancelTask(task.id);
    activeTasksByProjectId.value = {
      ...activeTasksByProjectId.value,
      [project.id]: (activeTasksByProjectId.value[project.id] ?? []).filter(
        (item) => item.id !== task.id,
      ),
    };
    ElMessage.success('已请求停止构建');
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close')
      ElMessage.error(errorMessage(caught, '停止构建失败'));
  } finally {
    stoppingProjectId.value = null;
  }
}
function handleMoreCommand(command: string, project: ProjectView): void {
  if (command === 'edit') {
    void router.push({ name: 'project-edit', params: { projectId: project.id } });
  } else if (command === 'delete') {
    void confirmDelete(project);
  }
}

async function confirmDelete(project: ProjectView): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定软删除项目“${project.name}”吗？删除后项目将从列表中隐藏。`,
      '确认删除项目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
    await projectApi.deleteProject(project.id);
    ElMessage.success('项目已删除');
    if (items.value.length === 1 && page.value > 1) page.value -= 1;
    await load();
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') {
      ElMessage.error(errorMessage(caught));
    }
  }
}

onMounted(() => {
  void Promise.all([loadTemplates(), load()]);
});
</script>

<template>
  <section class="page-section">
    <div class="page-heading">
      <div>
        <h1>项目管理</h1>
        <p>管理构建项目配置、Git 分支绑定与当前就绪状态。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="load">刷新</el-button>
        <el-button type="primary" @click="router.push({ name: 'project-new' })">新建项目</el-button>
      </div>
    </div>

    <div class="project-stats-grid">
      <MetricCard label="项目总数" :value="total" hint="当前可访问项目" />
      <MetricCard label="就绪可构建" :value="buildableCount" type="success" hint="配置与节点正常" />
      <MetricCard
        label="配置需调整"
        :value="incompatibleCount"
        type="danger"
        hint="模板更新或字段缺失"
      />
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form inline @submit.prevent="submitSearch">
        <el-form-item label="名称">
          <el-input
            v-model="search"
            clearable
            placeholder="搜索项目名称"
            @keyup.enter="submitSearch"
          />
        </el-form-item>
        <el-form-item label="构建模板">
          <el-select
            v-model="buildTemplateId"
            clearable
            filterable
            placeholder="全部模板"
            style="width: 220px"
            @change="submitSearch"
          >
            <el-option
              v-for="template in templates"
              :key="template.id"
              :label="template.name"
              :value="template.id"
            />
          </el-select>
        </el-form-item>
        <el-button type="primary" @click="submitSearch">搜索</el-button>
      </el-form>
    </el-card>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    />
    <el-alert
      v-if="!hasLoadedTemplates && !error"
      title="构建模板正在加载"
      type="info"
      :closable="false"
      class="page-alert"
    />

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="items" row-key="id">
        <el-table-column prop="name" label="项目名称" min-width="180">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              class="project-name-link"
              @click="router.push({ name: 'project-detail', params: { projectId: row.id } })"
            >
              {{ row.name }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column v-if="isAdmin" label="所有者" width="130">
          <template #default="{ row }">
            <span class="user-cell">{{ row.owner.username }}</span>
          </template>
        </el-table-column>
        <el-table-column label="模板" min-width="160">
          <template #default="{ row }">{{ templateName(toProject(row)) }}</template>
        </el-table-column>
        <el-table-column prop="branch" label="分支" min-width="150">
          <template #default="{ row }">
            <code class="branch-tag">{{ row.branch }}</code>
          </template>
        </el-table-column>
        <el-table-column label="Agent" width="120">
          <template #default="{ row }">
            <StatusBadge
              :type="agentStatusType(row.buildTemplate.agent)"
              :text="agentStatusDisplayText(toProject(row))"
              :pulse="
                row.buildTemplate.agent.enabled && row.buildTemplate.agent.status === 'ONLINE'
              "
            />
          </template>
        </el-table-column>
        <el-table-column label="配置" width="130">
          <template #default="{ row }">
            <StatusBadge
              :type="compatibilityType(toProject(row))"
              :text="compatibilityDisplayText(toProject(row))"
            />
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="175">
          <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="220" fixed="right">
          <template #default="{ row }">
            <div class="project-operation-actions">
              <el-button
                link
                type="primary"
                @click="router.push({ name: 'project-detail', params: { projectId: row.id } })"
              >
                详情
              </el-button>
              <el-button
                link
                type="primary"
                @click="router.push({ name: 'project-config', params: { projectId: row.id } })"
              >
                参数配置
              </el-button>
              <div class="project-operation-shortcuts">
                <el-tooltip :content="startBuildTitle(toProject(row))" placement="top">
                  <el-button
                    class="project-operation-icon-button project-operation-icon-button--start"
                    :loading="startingProjectId === row.id"
                    :disabled="!canStartBuild(toProject(row))"
                    aria-label="开始构建"
                    @click="startBuild(toProject(row))"
                  >
                    <el-icon v-if="startingProjectId !== row.id" aria-hidden="true">
                      <VideoPlay />
                    </el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="stopBuildTitle(toProject(row))" placement="top">
                  <el-button
                    class="project-operation-icon-button project-operation-icon-button--stop"
                    :loading="stoppingProjectId === row.id"
                    :disabled="!canStopBuild(toProject(row))"
                    aria-label="停止构建"
                    @click="openStopDialog(toProject(row))"
                  >
                    <svg
                      class="project-operation-stop-icon"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <rect x="3" y="3" width="10" height="10" rx="1" />
                    </svg>
                  </el-button>
                </el-tooltip>
              </div>
              <el-dropdown
                trigger="click"
                @command="handleMoreCommand($event, toProject(row))"
                @click.stop
              >
                <el-button link type="primary">更多</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="edit">编辑基本信息</el-dropdown-item>
                    <el-dropdown-item command="delete" divided>删除项目</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && items.length === 0" description="暂无项目" />

      <div class="pagination-row">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          layout="total, sizes, prev, pager, next"
          :total="total"
          @current-change="load"
          @size-change="load"
        />
      </div>
      <el-dialog
        v-model="stopDialogVisible"
        title="选择要停止的构建"
        width="min(460px, calc(100vw - 32px))"
        @closed="resetStopDialog"
      >
        <template v-if="stopDialogProject">
          <p class="project-stop-dialog__hint">
            项目“{{ stopDialogProject.name }}”有多个可取消的活动任务，请选择要停止的任务。
          </p>
          <el-radio-group v-model="selectedStopTaskId" class="project-stop-dialog__options">
            <el-radio
              v-for="task in stopDialogTasks"
              :key="task.id"
              :value="task.id"
              border
              class="project-stop-task-option"
            >
              <span class="project-stop-task-option__id">{{ shortTaskId(task.id) }}</span>
              <span>{{ taskStatusLabel(task.status) }}</span>
              <span class="muted-text">{{ formatTaskDate(task.createdAt) }}</span>
            </el-radio>
          </el-radio-group>
        </template>
        <template #footer>
          <div class="project-stop-dialog__footer">
            <el-button @click="stopDialogVisible = false">取消</el-button>
            <el-button
              type="danger"
              :loading="stoppingProjectId === stopDialogProjectId"
              :disabled="!selectedStopTaskId"
              @click="confirmSelectedStopTask"
            >
              停止构建
            </el-button>
          </div>
        </template>
      </el-dialog>
    </el-card>
  </section>
</template>

<style scoped>
.project-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.filter-card {
  border-radius: var(--ar-radius-lg);
}

.project-name-link {
  font-weight: 600;
  font-size: 14px;
}

.branch-tag {
  background: var(--ar-bg-subtle);
  padding: 2px 6px;
  border-radius: var(--ar-radius-sm);
  color: var(--ar-color-slate-700);
  font-size: 12px;
}

.project-operation-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  white-space: nowrap;
  vertical-align: middle;
}

.project-operation-shortcuts {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.project-operation-actions :deep(.el-button) {
  margin-left: 0;
}

.project-operation-icon-button {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent !important;
  border-radius: 6px;
  background-color: transparent !important;
  box-shadow: none;
}

.project-operation-icon-button :deep(.el-icon) {
  font-size: 14px;
}

.project-operation-icon-button--start {
  color: var(--ar-status-success) !important;
}

.project-operation-icon-button--start:hover:not(:disabled) {
  color: var(--ar-status-success-text) !important;
  background-color: var(--ar-status-success-bg) !important;
  border-color: var(--ar-status-success-border) !important;
}

.project-operation-icon-button--stop {
  color: var(--ar-status-danger) !important;
}

.project-operation-icon-button--stop:hover:not(:disabled) {
  color: var(--ar-status-danger-text) !important;
  background-color: var(--ar-status-danger-bg) !important;
  border-color: var(--ar-status-danger-border) !important;
}

.project-operation-icon-button.is-disabled,
.project-operation-icon-button:disabled {
  color: var(--ar-text-muted) !important;
  background-color: var(--ar-bg-subtle) !important;
  border-color: var(--ar-border-color) !important;
  opacity: 1;
}

.project-operation-icon-button:focus-visible {
  outline: 2px solid var(--ar-color-primary);
  outline-offset: 2px;
}

.project-operation-stop-icon {
  display: block;
  width: 14px;
  height: 14px;
  fill: currentColor;
}

.project-stop-dialog__hint {
  margin: 0 0 16px;
  color: var(--ar-text-secondary);
}

.project-stop-dialog__options {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: 100%;
}

.project-stop-task-option {
  width: 100%;
  margin-right: 0;
}

.project-stop-task-option :deep(.el-radio__label) {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  width: 100%;
  overflow: hidden;
}

.project-stop-task-option__id {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ar-text-primary);
  font-family: var(--ar-font-mono);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.project-stop-task-option .muted-text {
  flex: 0 0 auto;
  white-space: nowrap;
}

.project-stop-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
@media (max-width: 768px) {
  .project-operation-actions {
    gap: 8px;
  }
}
</style>
