export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(payload: ApiErrorPayload, status: number) {
    super(payload.message);
    this.name = 'ApiError';
    this.code = payload.code;
    this.status = status;
    this.details = payload.details;
    this.requestId = payload.requestId;
  }
}

interface ApiClientConfiguration {
  getAccessToken: () => string | null;
  refreshAccessToken: () => Promise<boolean>;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | object | null;
  skipRefresh?: boolean;
}

const configuredBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').trim();
export const apiBaseUrl = configuredBaseUrl
  ? `${configuredBaseUrl.replace(/\/$/, '')}/api`
  : '/api';

let configuration: ApiClientConfiguration = {
  getAccessToken: () => null,
  refreshAccessToken: async () => false,
};

export function configureApiClient(next: ApiClientConfiguration): void {
  configuration = next;
}

function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const names = ['buildplatform_csrf', '__Host-buildplatform_csrf'];
  for (const name of names) {
    const prefix = `${name}=`;
    const cookie = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    if (cookie) return decodeURIComponent(cookie.slice(prefix.length));
  }
  return undefined;
}

function needsCsrf(path: string, method: string): boolean {
  return method !== 'GET' && (path === '/auth/refresh' || path === '/auth/logout');
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      { code: 'VALIDATION_FAILED', message: '服务端返回了无法识别的响应' },
      response.status,
    );
  }

  if (!response.ok) {
    const body = payload as Partial<ApiErrorPayload>;
    throw new ApiError(
      {
        code: typeof body.code === 'string' ? body.code : 'VALIDATION_FAILED',
        message: typeof body.message === 'string' ? body.message : '请求失败，请稍后重试',
        details: isRecord(body.details) ? body.details : undefined,
        requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
      },
      response.status,
    );
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldRetry(path: string, options: RequestOptions): boolean {
  return !options.skipRefresh && path !== '/auth/login' && path !== '/auth/refresh';
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  const accessToken = configuration.getAccessToken();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (needsCsrf(path, method)) {
    const token = csrfToken();
    if (token) headers.set('X-CSRF-Token', token);
  }

  let body = options.body;
  if (body !== undefined && typeof body !== 'string' && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    body,
    headers,
    credentials: 'include',
  });

  if (response.status === 401 && shouldRetry(path, options)) {
    const refreshed = await configuration.refreshAccessToken();
    if (refreshed) return apiRequest<T>(path, { ...options, skipRefresh: true });
  }
  return parseResponse<T>(response);
}
