<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/client';
import * as artifactApi from '@/api/artifacts';
import { clientLogWebSocketUrl, parseClientLogEvent } from '@/api/task-log';
import * as taskApi from '@/api/tasks';
import type { ArtifactSummary, TaskDetail, TaskLogEntry } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/errors';
import {
  formatBytes,
  formatTaskDate,
  isTerminalTask,
  taskOperationLabel,
  taskStatusLabel,
  taskStatusType,
} from './task-status';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const task = ref<TaskDetail | null>(null);
const artifacts = ref<ArtifactSummary[]>([]);
const artifactTotal = ref(0);
const artifactPage = ref(1);
const artifactPageSize = ref(20);
const loading = ref(false);
const error = ref('');
const logError = ref('');
const artifactError = ref('');
const logsLoading = ref(false);
const logConnection = ref('未连接');
const visibleLogEntries = ref<TaskLogEntry[]>([]);
const logOffset = ref(0);
const logContainer = ref<HTMLElement | null>(null);
const cancelBusy = ref(false);
const rebuildBusy = ref(false);
const artifactBusy = ref<string | null>(null);

let pollTimer: number | undefined;
let reconnectTimer: number | undefined;
let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let refreshAttempted = false;
let destroyed = false;
let logWork = Promise.resolve();
let contextGeneration = 0;
let socketTaskId: string | null = null;
let artifactRequestToken = 0;

const taskId = computed(() => {
  const value = route.params.taskId;
  return typeof value === 'string' ? value : '';
});
const operationLabel = computed(() => (task.value ? taskOperationLabel(task.value.status) : null));
const canRebuild = computed(
  () =>
    task.value !== null &&
    ['SUCCEEDED', 'FAILED', 'CANCELED', 'AGENT_LOST'].includes(task.value.status),
);

function stopPolling(): void {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  pollTimer = undefined;
}

function isCurrentContext(generation: number, expectedTaskId: string): boolean {
  return !destroyed && generation === contextGeneration && taskId.value === expectedTaskId;
}

function syncPolling(generation: number, expectedTaskId: string): void {
  if (!isCurrentContext(generation, expectedTaskId)) return;
  if (!task.value || isTerminalTask(task.value)) {
    stopPolling();
    return;
  }
  if (pollTimer === undefined) {
    pollTimer = window.setInterval(() => {
      if (!document.hidden) void loadTask(generation, expectedTaskId, true);
    }, 2_500);
  }
}

async function loadTask(
  generation = contextGeneration,
  expectedTaskId = taskId.value,
  silent = false,
): Promise<void> {
  if (!isCurrentContext(generation, expectedTaskId)) return;
  if (!silent) loading.value = true;
  if (!silent) error.value = '';
  try {
    const result = await taskApi.getTask(expectedTaskId);
    if (!isCurrentContext(generation, expectedTaskId)) return;
    task.value = result.task;
    syncPolling(generation, expectedTaskId);
  } catch (caught) {
    if (isCurrentContext(generation, expectedTaskId) && !silent)
      error.value = errorMessage(caught, '任务详情加载失败');
  } finally {
    if (isCurrentContext(generation, expectedTaskId) && !silent) loading.value = false;
  }
}

function nearLogBottom(): boolean {
  const element = logContainer.value;
  return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 100;
}

function appendLogEntry(entry: TaskLogEntry, generation = contextGeneration): void {
  if (!isCurrentContext(generation, taskId.value)) return;
  const shouldScroll = nearLogBottom();
  visibleLogEntries.value.push(entry);
  if (shouldScroll) {
    void nextTick(() => {
      const element = logContainer.value;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }
}

async function loadLogHistory(
  generation = contextGeneration,
  expectedTaskId = taskId.value,
): Promise<void> {
  if (!isCurrentContext(generation, expectedTaskId)) return;
  logsLoading.value = true;
  logError.value = '';
  visibleLogEntries.value = [];
  logOffset.value = 0;
  try {
    let offset = 0;
    for (let page = 0; page < 10_000; page += 1) {
      const result = await taskApi.readTaskLogs(expectedTaskId, offset);
      if (!isCurrentContext(generation, expectedTaskId)) return;
      for (const entry of result.entries) appendLogEntry(entry, generation);
      if (result.eof || result.nextOffset <= offset) {
        offset = result.nextOffset;
        break;
      }
      offset = result.nextOffset;
    }
    if (!isCurrentContext(generation, expectedTaskId)) return;
    logOffset.value = offset;
    connectLogs(generation, expectedTaskId);
  } catch (caught) {
    if (isCurrentContext(generation, expectedTaskId))
      logError.value = errorMessage(caught, '历史日志加载失败');
  } finally {
    if (isCurrentContext(generation, expectedTaskId)) logsLoading.value = false;
  }
}

async function fillLogGap(
  targetOffset: number,
  generation: number,
  expectedTaskId: string,
): Promise<void> {
  let offset = logOffset.value;
  for (let page = 0; page < 10_000 && offset < targetOffset; page += 1) {
    if (!isCurrentContext(generation, expectedTaskId)) return;
    const result = await taskApi.readTaskLogs(expectedTaskId, offset);
    if (!isCurrentContext(generation, expectedTaskId)) return;
    for (const entry of result.entries) appendLogEntry(entry, generation);
    if (result.nextOffset <= offset) throw new Error('日志偏移未前进');
    offset = result.nextOffset;
  }
  if (isCurrentContext(generation, expectedTaskId)) logOffset.value = offset;
}

async function processLogMessage(
  message: unknown,
  generation: number,
  expectedTaskId: string,
): Promise<void> {
  const event = parseClientLogEvent(message);
  if (!isCurrentContext(generation, expectedTaskId) || !event || event.taskId !== expectedTaskId)
    return;
  if (event.offset < logOffset.value) return;
  if (event.offset > logOffset.value) await fillLogGap(event.offset, generation, expectedTaskId);
  if (
    !isCurrentContext(generation, expectedTaskId) ||
    event.offset !== logOffset.value ||
    event.nextOffset <= event.offset
  )
    return;
  appendLogEntry(event.entry, generation);
  logOffset.value = event.nextOffset;
}

function sendSubscription(current: WebSocket, generation: number, expectedTaskId: string): void {
  if (!isCurrentContext(generation, expectedTaskId) || current.readyState !== WebSocket.OPEN)
    return;
  if (!auth.accessToken) return;
  current.send(JSON.stringify({ type: 'auth', accessToken: auth.accessToken }));
}

function scheduleReconnect(generation = contextGeneration, expectedTaskId = taskId.value): void {
  if (
    !isCurrentContext(generation, expectedTaskId) ||
    reconnectTimer !== undefined ||
    reconnectAttempt >= 5
  ) {
    if (isCurrentContext(generation, expectedTaskId) && reconnectAttempt >= 5) {
      logConnection.value = '自动重连已停止';
      logError.value = '实时日志连接不可用，请刷新页面重试';
    }
    return;
  }
  const delay = Math.min(8_000, 500 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  logConnection.value = `重连中（${reconnectAttempt}/5）`;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    if (isCurrentContext(generation, expectedTaskId)) connectLogs(generation, expectedTaskId);
  }, delay);
}

function connectLogs(generation = contextGeneration, expectedTaskId = taskId.value): void {
  if (!isCurrentContext(generation, expectedTaskId) || socket || !auth.accessToken) return;
  logConnection.value = '连接中';
  try {
    socket = new WebSocket(clientLogWebSocketUrl());
  } catch {
    logConnection.value = '连接失败';
    scheduleReconnect(generation, expectedTaskId);
    return;
  }
  const current = socket;
  socketTaskId = expectedTaskId;
  current.onopen = () => {
    if (!isCurrentContext(generation, expectedTaskId) || socket !== current) return;
    logConnection.value = '已连接';
    sendSubscription(current, generation, expectedTaskId);
  };
  current.onmessage = (event) => {
    if (!isCurrentContext(generation, expectedTaskId) || socket !== current) return;
    let value: unknown;
    try {
      value = JSON.parse(String(event.data)) as unknown;
    } catch {
      return;
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>).type === 'auth.ok'
    ) {
      reconnectAttempt = 0;
      refreshAttempted = false;
      current.send(
        JSON.stringify({
          type: 'task.log.subscribe',
          taskId: expectedTaskId,
          offset: logOffset.value,
        }),
      );
      return;
    }
    logWork = logWork
      .then(() => processLogMessage(value, generation, expectedTaskId))
      .catch(() => {
        if (isCurrentContext(generation, expectedTaskId))
          logError.value = '实时日志存在偏移缺口，请刷新页面重试';
      });
  };
  current.onerror = () => {
    if (isCurrentContext(generation, expectedTaskId) && socket === current)
      logConnection.value = '连接中断';
  };
  current.onclose = (event) => {
    if (socket === current) socket = null;
    if (!isCurrentContext(generation, expectedTaskId)) return;
    logConnection.value = '连接中断';
    if (event.code === 1008 && !refreshAttempted) {
      refreshAttempted = true;
      void auth.refreshSession().then((ok) => {
        if (!isCurrentContext(generation, expectedTaskId)) return;
        if (ok) {
          scheduleReconnect(generation, expectedTaskId);
        } else {
          logConnection.value = '认证失败，已停止重连';
          logError.value = '登录状态已失效，请重新登录';
          void router.replace({ name: 'login', query: { redirect: route.fullPath } });
        }
      });
      return;
    }
    scheduleReconnect(generation, expectedTaskId);
  };
}

function closeLogs(): void {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (socket?.readyState === WebSocket.OPEN) {
    if (socketTaskId) {
      socket.send(JSON.stringify({ type: 'task.log.unsubscribe', taskId: socketTaskId }));
    }
  }
  socket?.close(1000, 'page closed');
  socket = null;
  socketTaskId = null;
}

async function loadArtifacts(
  generation = contextGeneration,
  expectedTaskId = taskId.value,
): Promise<void> {
  if (!isCurrentContext(generation, expectedTaskId)) return;
  const requestToken = ++artifactRequestToken;
  artifactError.value = '';
  try {
    const result = await artifactApi.listTaskArtifacts(
      expectedTaskId,
      artifactPage.value,
      artifactPageSize.value,
    );
    if (!isCurrentContext(generation, expectedTaskId) || requestToken !== artifactRequestToken)
      return;
    artifacts.value = result.items;
    artifactTotal.value = result.total;
  } catch (caught) {
    if (isCurrentContext(generation, expectedTaskId) && requestToken === artifactRequestToken)
      artifactError.value = errorMessage(caught, '产物列表加载失败');
  }
}

function loadCurrentArtifacts(): void {
  void loadArtifacts(contextGeneration, taskId.value);
}

async function operateTask(): Promise<void> {
  if (!task.value || !operationLabel.value || cancelBusy.value || task.value.status === 'CANCELING')
    return;
  const generation = contextGeneration;
  const expectedTaskId = taskId.value;
  try {
    await ElMessageBox.confirm(
      `确定${operationLabel.value === '取消任务' ? '取消' : '停止'}当前任务吗？`,
      `确认${operationLabel.value}`,
      { type: 'warning', confirmButtonText: operationLabel.value, cancelButtonText: '暂不操作' },
    );
    cancelBusy.value = true;
    const result = await taskApi.cancelTask(expectedTaskId);
    if (!isCurrentContext(generation, expectedTaskId)) return;
    task.value = result.task;
    syncPolling(generation, expectedTaskId);
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close') {
      if (caught instanceof ApiError && caught.status === 409) {
        if (isCurrentContext(generation, expectedTaskId))
          await loadTask(generation, expectedTaskId);
        ElMessage.warning('任务状态已变化，已刷新当前状态');
      } else ElMessage.error(errorMessage(caught, '任务操作失败'));
    }
  } finally {
    cancelBusy.value = false;
  }
}

async function rebuild(): Promise<void> {
  if (!canRebuild.value || rebuildBusy.value) return;
  const generation = contextGeneration;
  const expectedTaskId = taskId.value;
  try {
    await ElMessageBox.confirm(
      '将使用项目当前配置、分支和模板创建全新任务，旧任务的日志和产物不会复制。是否继续？',
      '确认重新构建',
      { type: 'warning', confirmButtonText: '重新构建', cancelButtonText: '取消' },
    );
    rebuildBusy.value = true;
    const result = await taskApi.rebuildTask(expectedTaskId);
    if (!isCurrentContext(generation, expectedTaskId)) return;
    await router.push({ name: 'task-detail', params: { taskId: result.task.id } });
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close')
      ElMessage.error(errorMessage(caught, '重新构建失败'));
  } finally {
    rebuildBusy.value = false;
  }
}

async function download(download: () => Promise<{ blob: Blob; filename: string }>): Promise<void> {
  try {
    const result = await download();
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    link.click();
    URL.revokeObjectURL(url);
  } catch (caught) {
    ElMessage.error(errorMessage(caught, '下载失败'));
  }
}

async function removeArtifact(artifact: ArtifactSummary): Promise<void> {
  if (artifactBusy.value) return;
  try {
    await ElMessageBox.confirm(`确定删除产物“${artifact.relativePath}”吗？`, '确认删除产物', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    artifactBusy.value = artifact.id;
    await artifactApi.deleteArtifact(artifact.id);
    if (!isCurrentContext(contextGeneration, taskId.value)) return;
    ElMessage.success('产物已删除');
    await loadArtifacts(contextGeneration, taskId.value);
  } catch (caught) {
    if (caught !== 'cancel' && caught !== 'close')
      ElMessage.error(errorMessage(caught, '产物删除失败'));
  } finally {
    artifactBusy.value = null;
  }
}

function removeArtifactFromRow(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('id' in value)) return;
  const id = (value as { id?: unknown }).id;
  if (typeof id !== 'string') return;
  const artifact = artifacts.value.find((item) => item.id === id);
  if (artifact) void removeArtifact(artifact);
}

function resetTaskContext(): number {
  const generation = ++contextGeneration;
  stopPolling();
  closeLogs();
  artifactRequestToken += 1;
  task.value = null;
  loading.value = false;
  visibleLogEntries.value = [];
  logOffset.value = 0;
  artifacts.value = [];
  artifactTotal.value = 0;
  artifactPage.value = 1;
  error.value = '';
  logError.value = '';
  artifactError.value = '';
  logConnection.value = '未连接';
  logsLoading.value = false;
  cancelBusy.value = false;
  rebuildBusy.value = false;
  artifactBusy.value = null;
  reconnectAttempt = 0;
  refreshAttempted = false;
  logWork = Promise.resolve();
  return generation;
}

async function loadTaskContext(): Promise<void> {
  if (destroyed) return;
  const generation = resetTaskContext();
  const expectedTaskId = taskId.value;
  await Promise.all([
    loadTask(generation, expectedTaskId),
    loadLogHistory(generation, expectedTaskId),
    loadArtifacts(generation, expectedTaskId),
  ]);
}

function onVisibilityChange(): void {
  if (!document.hidden) void loadTask(contextGeneration, taskId.value, true);
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange);
  void loadTaskContext();
});

watch(taskId, (next, previous) => {
  if (next !== previous) void loadTaskContext();
});

onBeforeUnmount(() => {
  destroyed = true;
  contextGeneration += 1;
  stopPolling();
  closeLogs();
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
  <section class="page-section task-detail-page">
    <div class="page-heading">
      <div>
        <h1>任务详情</h1>
        <p>查看构建状态、日志和产物。</p>
      </div>
      <div class="page-heading__actions">
        <el-button @click="router.back()">返回</el-button>
        <el-button
          v-if="task"
          :loading="cancelBusy"
          :disabled="!operationLabel || task.status === 'CANCELING'"
          @click="operateTask"
        >
          {{ operationLabel || '任务已结束' }}
        </el-button>
        <el-button v-if="canRebuild" type="primary" :loading="rebuildBusy" @click="rebuild"
          >重新构建</el-button
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

    <template v-else-if="task">
      <el-card shadow="never">
        <div class="task-status-header">
          <div>
            <span class="detail-label">当前状态</span>
            <el-tag :type="taskStatusType(task.status)" size="large">{{
              taskStatusLabel(task.status)
            }}</el-tag>
            <p v-if="task.statusReason" class="muted-text">{{ task.statusReason }}</p>
          </div>
          <div class="task-status-header__hint">
            {{ task.project.name }} · {{ task.buildTemplate.name }}
          </div>
        </div>
        <div class="detail-grid task-metrics">
          <div>
            <span class="detail-label">项目</span
            ><el-button
              link
              type="primary"
              @click="
                router.push({ name: 'project-detail', params: { projectId: task.projectId } })
              "
              >{{ task.project.name }}</el-button
            >
          </div>
          <div><span class="detail-label">构建模板</span>{{ task.buildTemplate.name }}</div>
          <div>
            <span class="detail-label">Agent</span>{{ task.agent.name }}
            <el-tag
              size="small"
              :type="
                task.agent.enabled
                  ? task.agent.status === 'ONLINE'
                    ? 'success'
                    : 'warning'
                  : 'danger'
              "
              >{{
                task.agent.enabled ? (task.agent.status === 'ONLINE' ? '在线' : '离线') : '已停用'
              }}</el-tag
            >
          </div>
          <div>
            <span class="detail-label">分支</span><code>{{ task.branch }}</code>
          </div>
          <div>
            <span class="detail-label">Commit SHA</span><code>{{ task.sourceCommit || '—' }}</code>
          </div>
          <div><span class="detail-label">创建人</span>{{ task.creator.username }}</div>
          <div><span class="detail-label">创建时间</span>{{ formatTaskDate(task.createdAt) }}</div>
          <div><span class="detail-label">排队时间</span>{{ formatTaskDate(task.queuedAt) }}</div>
          <div><span class="detail-label">开始时间</span>{{ formatTaskDate(task.startedAt) }}</div>
          <div><span class="detail-label">完成时间</span>{{ formatTaskDate(task.finishedAt) }}</div>
          <div><span class="detail-label">命令退出码</span>{{ task.exitCode ?? '—' }}</div>
          <div><span class="detail-label">日志大小</span>{{ formatBytes(task.logSize) }}</div>
          <div>
            <span class="detail-label">产物统计</span>{{ task.artifactCount }} 个 /
            {{ formatBytes(task.artifactBytes) }}
          </div>
        </div>
      </el-card>

      <el-card shadow="never">
        <template #header>状态时间线</template>
        <el-timeline v-if="task.statusHistory.length">
          <el-timeline-item
            v-for="item in task.statusHistory"
            :key="item.id"
            :timestamp="formatTaskDate(item.occurredAt)"
          >
            <strong
              >{{ item.fromStatus ? taskStatusLabel(item.fromStatus) : '初始状态' }} →
              {{ taskStatusLabel(item.toStatus) }}</strong
            >
            <div class="muted-text">
              来源：{{ item.source }}{{ item.reason ? ` · ${item.reason}` : '' }}
            </div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无状态历史" />
      </el-card>

      <el-card shadow="never">
        <template #header>
          <div class="card-header-line">
            <span>构建日志</span><span class="muted-text">{{ logConnection }}</span>
          </div>
        </template>
        <div class="page-heading__actions log-actions">
          <el-button size="small" @click="visibleLogEntries = []">清空当前显示</el-button>
          <span v-if="logsLoading" class="muted-text">历史日志加载中…</span>
          <span v-if="logError" class="error-text">{{ logError }}</span>
        </div>
        <div ref="logContainer" class="task-log-viewer">
          <div
            v-for="entry in visibleLogEntries"
            :key="`${entry.sequence}-${entry.stream}-${entry.emittedAt}`"
            class="task-log-line"
            :class="`task-log-line--${entry.stream}`"
          >
            <span class="task-log-line__meta"
              >{{ formatTaskDate(entry.emittedAt) }} [{{ entry.stream }}]</span
            ><span>{{ entry.chunk }}</span>
          </div>
          <el-empty v-if="!logsLoading && visibleLogEntries.length === 0" description="暂无日志" />
        </div>
      </el-card>

      <el-card shadow="never">
        <template #header
          ><div class="card-header-line">
            <span>产物</span
            ><el-button
              size="small"
              @click="download(() => artifactApi.downloadTaskArchive(taskId))"
              >下载 ZIP</el-button
            >
          </div></template
        >
        <el-alert
          v-if="artifactError"
          :title="artifactError"
          type="error"
          :closable="false"
          class="page-alert"
        />
        <el-table v-loading="false" :data="artifacts" row-key="id">
          <el-table-column prop="relativePath" label="路径" min-width="260" />
          <el-table-column prop="fileName" label="文件名" min-width="150" />
          <el-table-column label="大小" width="120"
            ><template #default="{ row }">{{ formatBytes(row.size) }}</template></el-table-column
          >
          <el-table-column label="SHA-256" min-width="260"
            ><template #default="{ row }"
              ><code>{{ row.sha256 }}</code></template
            ></el-table-column
          >
          <el-table-column label="创建时间" width="175"
            ><template #default="{ row }">{{
              formatTaskDate(row.createdAt)
            }}</template></el-table-column
          >
          <el-table-column label="操作" width="160" fixed="right"
            ><template #default="{ row }"
              ><el-button
                link
                type="primary"
                @click="download(() => artifactApi.downloadArtifact(row.id))"
                >下载</el-button
              ><el-button
                link
                type="danger"
                :loading="artifactBusy === row.id"
                @click="removeArtifactFromRow(row)"
                >删除</el-button
              ></template
            ></el-table-column
          >
        </el-table>
        <el-empty v-if="artifacts.length === 0 && !artifactError" description="暂无产物" />
        <div class="pagination-row">
          <el-pagination
            v-model:current-page="artifactPage"
            v-model:page-size="artifactPageSize"
            layout="total, sizes, prev, pager, next"
            :total="artifactTotal"
            @current-change="loadCurrentArtifacts"
            @size-change="loadCurrentArtifacts"
          />
        </div>
      </el-card>
    </template>
  </section>
</template>
