import type { TaskLogEntry } from './types';

export interface ClientLogEvent {
  type: 'task.log';
  taskId: string;
  offset: number;
  nextOffset: number;
  entry: TaskLogEntry;
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
