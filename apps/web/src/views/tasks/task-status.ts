import type { BuildTaskStatus, TaskDetail, TaskSummary } from '@/api/types';

export const TASK_STATUS_LABELS: Record<BuildTaskStatus, string> = {
  CREATED: '已创建',
  WAITING_AGENT: '等待 Agent',
  QUEUED: '排队中',
  DISPATCHED: '已派发',
  PREPARING: '准备中',
  RUNNING: '执行中',
  UPLOADING: '上传产物',
  SUCCEEDED: '成功',
  FAILED: '失败',
  CANCELING: '正在停止',
  CANCELED: '已取消',
  AGENT_LOST: 'Agent 失联',
};

export const TASK_STATUSES = Object.keys(TASK_STATUS_LABELS) as BuildTaskStatus[];
export const TERMINAL_TASK_STATUSES: readonly BuildTaskStatus[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
];

export function taskStatusLabel(status: BuildTaskStatus): string {
  return TASK_STATUS_LABELS[status];
}

export function taskStatusType(status: BuildTaskStatus): 'success' | 'warning' | 'info' | 'danger' {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED' || status === 'AGENT_LOST') return 'danger';
  if (status === 'WAITING_AGENT' || status === 'QUEUED' || status === 'CANCELING') return 'warning';
  return 'info';
}

export function isTerminalTask(task: TaskSummary | TaskDetail): boolean {
  return TERMINAL_TASK_STATUSES.includes(task.status);
}

export function taskOperationLabel(status: BuildTaskStatus): string | null {
  if (status === 'CREATED' || status === 'WAITING_AGENT' || status === 'QUEUED') return '取消任务';
  if (['DISPATCHED', 'PREPARING', 'RUNNING', 'UPLOADING'].includes(status)) return '停止任务';
  if (status === 'CANCELING') return '正在停止';
  return null;
}

export function formatTaskDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

export function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return value;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function shortTaskId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
