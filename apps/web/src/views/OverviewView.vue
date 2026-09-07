<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { getOverview } from '@/api/overview';
import { ApiError } from '@/api/client';
import type { OverviewAgent, OverviewResponse, OverviewTask } from '@/api/types';
import MetricCard from '@/components/MetricCard.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { errorMessage } from '@/utils/errors';
import { formatTaskDate, taskStatusLabel, taskStatusType } from '@/views/tasks/task-status';

const router = useRouter();
const overview = ref<OverviewResponse | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref('');
let disposed = false;
let requestGeneration = 0;
let requestInFlight = false;
let pollingTimer: number | undefined;

const metricCards = computed(() => {
  const metrics = overview.value?.metrics;
  return [
    { label: 'Agent 总数', value: metrics?.agentTotal ?? 0, type: 'primary' as const },
    { label: '在线 Agent', value: metrics?.onlineAgentCount ?? 0, type: 'success' as const },
    { label: '执行中任务', value: metrics?.runningTaskCount ?? 0, type: 'warning' as const },
    { label: '排队任务', value: metrics?.queuedTaskCount ?? 0, type: 'default' as const },
  ];
});

function agentStatusLabel(agent: OverviewAgent): string {
  if (!agent.enabled || agent.status === 'DISABLED') return '已停用';
  return agent.status === 'ONLINE' ? '在线' : '离线';
}

function agentStatusType(agent: OverviewAgent): 'success' | 'warning' | 'danger' {
  if (!agent.enabled || agent.status === 'DISABLED') return 'danger';
  return agent.status === 'ONLINE' ? 'success' : 'warning';
}

function taskElapsed(task: OverviewTask): string {
  const isRunning =
    task.status !== 'CREATED' && task.status !== 'WAITING_AGENT' && task.status !== 'QUEUED';
  const startedAt = isRunning
    ? (task.startedAt ?? task.createdAt)
    : (task.queuedAt ?? task.createdAt);
  const elapsed = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `已${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  return `已${hours}小时${minutes % 60 ? ` ${minutes % 60}分钟` : ''}`;
}

function taskAriaLabel(task: OverviewTask): string {
  return `${task.projectName}，${task.templateName}，${taskStatusLabel(task.status)}，按回车查看详情`;
}

function openTask(task: OverviewTask): void {
  void router.push({ name: 'task-detail', params: { taskId: task.id } });
}

async function loadOverview(): Promise<void> {
  if (disposed || requestInFlight) return;
  requestInFlight = true;
  const generation = ++requestGeneration;
  if (overview.value === null) loading.value = true;
  else refreshing.value = true;
  try {
    const result = await getOverview();
    if (disposed || generation !== requestGeneration) return;
    overview.value = result;
    error.value = '';
  } catch (caught) {
    if (disposed || generation !== requestGeneration) return;
    error.value =
      caught instanceof ApiError
        ? errorMessage(caught, '任务概览加载失败，请稍后重试')
        : '任务概览加载失败，请稍后重试';
  } finally {
    requestInFlight = false;
    if (!disposed && generation === requestGeneration) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

function stopPolling(): void {
  if (pollingTimer !== undefined) {
    window.clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

function startPolling(): void {
  stopPolling();
  if (document.hidden || disposed) return;
  pollingTimer = window.setInterval(() => {
    if (!document.hidden) void loadOverview();
  }, 30_000);
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    stopPolling();
    return;
  }
  void loadOverview();
  startPolling();
}

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibilityChange);
  startPolling();
  void loadOverview();
});

onUnmounted(() => {
  disposed = true;
  requestGeneration += 1;
  stopPolling();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <div class="page-section overview-page">
    <div class="page-heading overview-heading">
      <div>
        <h1>任务概览</h1>
        <p>查看当前可见任务与 Agent 的实时状态，页面每 30 秒自动刷新。</p>
      </div>
      <div class="page-heading__actions">
        <span v-if="overview" class="overview-updated"
          >更新于 {{ formatTaskDate(overview.generatedAt) }}</span
        >
        <el-button type="primary" plain :loading="refreshing" @click="loadOverview"
          >手动刷新</el-button
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

    <el-skeleton v-if="loading" :rows="8" animated class="overview-skeleton" />
    <template v-else-if="overview">
      <div class="overview-metrics">
        <MetricCard v-for="card in metricCards" :key="card.label" v-bind="card" />
      </div>

      <el-empty
        v-if="overview.agents.length === 0"
        description="暂无 Agent"
        class="overview-empty"
      />
      <div v-else class="agent-lanes">
        <section v-for="agent in overview.agents" :key="agent.id" class="agent-lane">
          <header class="agent-lane__header">
            <div class="agent-lane__identity">
              <div class="agent-lane__title-row">
                <h2>{{ agent.name }}</h2>
                <StatusBadge :type="agentStatusType(agent)" :text="agentStatusLabel(agent)" />
              </div>
              <p class="agent-lane__meta">
                <span v-if="agent.hostname">{{ agent.hostname }}</span>
                <span v-else>主机信息未上报</span>
                <span>最后在线：{{ formatTaskDate(agent.lastSeenAt) }}</span>
              </p>
            </div>
          </header>

          <div class="agent-lane__columns">
            <section class="task-column">
              <div class="task-column__heading">
                <h3>正在进行</h3>
                <span>{{ agent.runningTasks.length }}</span>
              </div>
              <el-empty
                v-if="agent.runningTasks.length === 0"
                :image-size="48"
                description="暂无执行中任务"
              />
              <div v-else class="task-list">
                <button
                  v-for="task in agent.runningTasks"
                  :key="task.id"
                  type="button"
                  class="overview-task"
                  :aria-label="taskAriaLabel(task)"
                  @click="openTask(task)"
                  @keydown.enter="openTask(task)"
                  @keydown.space.prevent="openTask(task)"
                >
                  <div class="overview-task__main">
                    <strong>{{ task.projectName }}</strong>
                    <span>{{ task.templateName }}</span>
                  </div>
                  <div class="overview-task__details">
                    <StatusBadge
                      :type="taskStatusType(task.status)"
                      :text="taskStatusLabel(task.status)"
                      size="small"
                    />
                    <span>{{ taskElapsed(task) }}</span>
                  </div>
                </button>
              </div>
            </section>

            <section class="task-column">
              <div class="task-column__heading">
                <h3>排队中</h3>
                <span>{{ agent.queuedTasks.length }}</span>
              </div>
              <el-empty
                v-if="agent.queuedTasks.length === 0"
                :image-size="48"
                description="暂无排队任务"
              />
              <div v-else class="task-list">
                <button
                  v-for="(task, index) in agent.queuedTasks"
                  :key="task.id"
                  type="button"
                  class="overview-task"
                  :aria-label="taskAriaLabel(task)"
                  @click="openTask(task)"
                  @keydown.enter="openTask(task)"
                  @keydown.space.prevent="openTask(task)"
                >
                  <span class="overview-task__order">#{{ index + 1 }}</span>
                  <div class="overview-task__main">
                    <strong>{{ task.projectName }}</strong>
                    <span>{{ task.templateName }}</span>
                  </div>
                  <div class="overview-task__details">
                    <StatusBadge
                      :type="taskStatusType(task.status)"
                      :text="taskStatusLabel(task.status)"
                      size="small"
                    />
                    <span v-if="task.status === 'WAITING_AGENT'" class="overview-task__waiting"
                      >等待 Agent 上线</span
                    >
                    <span v-else>{{ taskElapsed(task) }}</span>
                  </div>
                </button>
              </div>
            </section>

            <section class="task-column task-column--recent">
              <div class="task-column__heading">
                <h3>最近完成</h3>
                <span>{{ agent.recentTasks.length }}</span>
              </div>
              <el-empty
                v-if="agent.recentTasks.length === 0"
                :image-size="48"
                description="暂无历史任务"
              />
              <div v-else class="task-list">
                <button
                  v-for="task in agent.recentTasks"
                  :key="task.id"
                  type="button"
                  class="overview-task overview-task--recent"
                  :aria-label="taskAriaLabel(task)"
                  @click="openTask(task)"
                  @keydown.enter="openTask(task)"
                  @keydown.space.prevent="openTask(task)"
                >
                  <div class="overview-task__main">
                    <strong>{{ task.projectName }}</strong>
                    <span>{{ task.templateName }}</span>
                  </div>
                  <div class="overview-task__details">
                    <StatusBadge
                      :type="taskStatusType(task.status)"
                      :text="taskStatusLabel(task.status)"
                      size="small"
                    />
                    <span>{{ formatTaskDate(task.finishedAt) }}</span>
                  </div>
                </button>
              </div>
            </section>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.overview-page {
  min-width: 0;
}

.overview-heading {
  align-items: center;
}

.overview-updated {
  color: var(--ar-text-muted);
  font-size: 12px;
}

.overview-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.overview-skeleton,
.overview-empty {
  margin-top: 20px;
}

.agent-lanes {
  display: grid;
  gap: 16px;
  margin-top: 20px;
}

.agent-lane {
  overflow: hidden;
  border: 1px solid var(--ar-border-color);
  border-radius: var(--ar-radius-lg);
  background: var(--ar-bg-card);
  box-shadow: var(--ar-shadow-xs);
}

.agent-lane__header {
  display: flex;
  justify-content: space-between;
  padding: 18px 20px;
  border-bottom: 1px solid var(--ar-border-subtle);
}

.agent-lane__title-row,
.agent-lane__meta,
.task-column__heading,
.overview-task__details {
  display: flex;
  align-items: center;
  gap: 10px;
}

.agent-lane__title-row h2 {
  margin: 0;
  color: var(--ar-text-primary);
  font-size: 16px;
}

.agent-lane__meta {
  flex-wrap: wrap;
  margin: 8px 0 0;
  color: var(--ar-text-secondary);
  font-size: 12px;
}

.agent-lane__meta span + span::before {
  margin-right: 10px;
  content: '·';
  color: var(--ar-text-muted);
}

.agent-lane__columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
  min-width: 0;
  padding: 18px 20px 20px;
}

.task-column {
  min-width: 0;
}

.task-column__heading {
  justify-content: space-between;
  margin-bottom: 10px;
}

.task-column__heading h3 {
  margin: 0;
  color: var(--ar-text-primary);
  font-size: 14px;
}

.task-column__heading > span {
  min-width: 22px;
  padding: 2px 7px;
  border-radius: var(--ar-radius-full);
  background: var(--ar-bg-subtle);
  color: var(--ar-text-secondary);
  font-size: 12px;
  text-align: center;
}

.task-list {
  display: grid;
  gap: 8px;
}

.overview-task {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--ar-border-color);
  border-radius: var(--ar-radius-md);
  background: var(--ar-bg-card);
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: var(--ar-transition-base);
}

.overview-task--recent {
  grid-template-columns: minmax(0, 1fr) auto;
}

.overview-task:hover,
.overview-task:focus-visible {
  border-color: var(--ar-color-primary);
  box-shadow: var(--ar-shadow-xs);
  outline: none;
}

.overview-task__order {
  align-self: center;
  color: var(--ar-color-primary);
  font-family: var(--ar-font-mono);
  font-size: 12px;
  font-weight: 600;
}

.overview-task__main {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.overview-task__main strong,
.overview-task__main span,
.overview-task__details span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-task__main strong {
  color: var(--ar-text-primary);
  font-size: 13px;
}

.overview-task__main span,
.overview-task__details span {
  color: var(--ar-text-secondary);
  font-size: 12px;
}

.overview-task__details {
  justify-content: flex-end;
  flex-wrap: wrap;
  min-width: 0;
}

.overview-task__waiting {
  color: var(--ar-status-warning-text) !important;
}

@media (max-width: 1200px) and (min-width: 901px) {
  .agent-lane__columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .task-column--recent {
    grid-column: 1 / -1;
  }

  .task-column--recent .task-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .overview-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .agent-lane__columns {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .overview-metrics {
    grid-template-columns: 1fr;
  }

  .agent-lane__header,
  .agent-lane__columns {
    padding-right: 14px;
    padding-left: 14px;
  }

  .overview-task {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .overview-task__details {
    grid-column: 2;
    justify-content: flex-start;
  }
}
</style>
