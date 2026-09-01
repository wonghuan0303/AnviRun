import { apiRequest } from './client';
import type { BuildTaskStatus, TaskDetail, TaskLogPage, TaskPage } from './types';

export interface TaskListParams {
  page?: number;
  pageSize?: number;
  status?: BuildTaskStatus;
}

function newIdempotencyKey(prefix: string): string {
  const random = Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${random}`.slice(0, 128);
}

function queryString(params: TaskListParams): string {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  if (params.status) query.set('status', params.status);
  return query.toString() ? `?${query.toString()}` : '';
}

export function createTask(
  projectId: string,
  idempotencyKey = newIdempotencyKey('create-task'),
): Promise<{ task: TaskDetail }> {
  return apiRequest<{ task: TaskDetail }>(`/projects/${projectId}/tasks`, {
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function listProjectTasks(
  projectId: string,
  params: TaskListParams = {},
): Promise<TaskPage> {
  return apiRequest<TaskPage>(`/projects/${projectId}/tasks${queryString(params)}`);
}

export function getTask(taskId: string): Promise<{ task: TaskDetail }> {
  return apiRequest<{ task: TaskDetail }>(`/tasks/${taskId}`);
}

export function cancelTask(
  taskId: string,
  reason = '用户请求停止任务',
): Promise<{ task: TaskDetail }> {
  return apiRequest<{ task: TaskDetail }>(`/tasks/${taskId}/cancel`, {
    method: 'POST',
    body: { reason },
  });
}

export function rebuildTask(
  taskId: string,
  idempotencyKey = newIdempotencyKey('rebuild-task'),
): Promise<{ task: TaskDetail }> {
  return apiRequest<{ task: TaskDetail }>(`/tasks/${taskId}/rebuild`, {
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function readTaskLogs(taskId: string, offset = 0, limit = 1_048_576): Promise<TaskLogPage> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return apiRequest<TaskLogPage>(`/tasks/${taskId}/logs?${query.toString()}`);
}
