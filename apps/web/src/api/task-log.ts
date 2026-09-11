import type { TaskLogEntry } from './types';

export interface ClientLogEvent {
  type: 'task.log';
  taskId: string;
  offset: number;
  nextOffset: number;
  entry: TaskLogEntry;
}

export interface TaskInputStateEvent {
  type: 'task.input.state';
  taskId: string;
  enabled: boolean;
  writable: boolean;
  controlledByCurrentSocket: boolean;
  busy: boolean;
  reason?: string;
  requestId?: string;
}

export interface TaskInputResultEvent {
  type: 'task.input.result';
  taskId: string;
  inputId: string;
  status: 'DELIVERED' | 'REJECTED';
  code?: string;
  message?: string;
}

export function clientLogWebSocketUrl(): string {
  const configured = (import.meta.env.VITE_API_BASE_URL ?? '').trim();
  if (configured) {
    const url = new URL(configured);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/client';
    url.search = '';
    return url.toString();
  }
  if (typeof window === 'undefined') return 'ws://127.0.0.1:3000/ws/client';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/client`;
}

export function parseClientLogEvent(value: unknown): ClientLogEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type !== 'task.log' ||
    typeof record.taskId !== 'string' ||
    typeof record.offset !== 'number' ||
    typeof record.nextOffset !== 'number' ||
    typeof record.entry !== 'object' ||
    record.entry === null
  )
    return undefined;
  const entry = record.entry as Record<string, unknown>;
  if (
    typeof entry.sequence !== 'number' ||
    (entry.stream !== 'stdout' && entry.stream !== 'stderr') ||
    typeof entry.chunk !== 'string' ||
    typeof entry.emittedAt !== 'string'
  )
    return undefined;
  return {
    type: 'task.log',
    taskId: record.taskId,
    offset: record.offset,
    nextOffset: record.nextOffset,
    entry: {
      sequence: entry.sequence,
      stream: entry.stream,
      chunk: entry.chunk,
      emittedAt: entry.emittedAt,
    },
  };
}

export function parseTaskInputState(value: unknown): TaskInputStateEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type !== 'task.input.state' ||
    typeof record.taskId !== 'string' ||
    typeof record.enabled !== 'boolean' ||
    typeof record.writable !== 'boolean' ||
    typeof record.controlledByCurrentSocket !== 'boolean' ||
    typeof record.busy !== 'boolean'
  )
    return undefined;
  return {
    type: 'task.input.state',
    taskId: record.taskId,
    enabled: record.enabled,
    writable: record.writable,
    controlledByCurrentSocket: record.controlledByCurrentSocket,
    busy: record.busy,
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
  };
}

export function parseTaskInputResult(value: unknown): TaskInputResultEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type !== 'task.input.result' ||
    typeof record.taskId !== 'string' ||
    typeof record.inputId !== 'string' ||
    (record.status !== 'DELIVERED' && record.status !== 'REJECTED')
  )
    return undefined;
  return {
    type: 'task.input.result',
    taskId: record.taskId,
    inputId: record.inputId,
    status: record.status,
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
  };
}
