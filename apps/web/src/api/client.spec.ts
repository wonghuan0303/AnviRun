import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest, configureApiClient } from './client';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiRequest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    configureApiClient({
      getAccessToken: () => 'access-token',
      refreshAccessToken: async () => false,
    });
  });

  it('sends Bearer token and credentials include', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/admin/agents');

    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect((options.headers as Headers).get('Authorization')).toBe('Bearer access-token');
    expect(options.credentials).toBe('include');
  });

  it('refreshes once and retries a 401 request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401))
      .mockResolvedValueOnce(response({ ok: true }));
    const refresh = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('fetch', fetchMock);
    configureApiClient({ getAccessToken: () => 'new-token', refreshAccessToken: refresh });

    await expect(apiRequest('/admin/agents')).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry indefinitely when refresh fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401));
    const refresh = vi.fn().mockResolvedValue(false);
    vi.stubGlobal('fetch', fetchMock);
    configureApiClient({ getAccessToken: () => 'old-token', refreshAccessToken: refresh });

    await expect(apiRequest('/admin/agents')).rejects.toMatchObject({
      code: 'AUTH_TOKEN_EXPIRED',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('downloads a Blob with Bearer authentication and retries once after refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401))
      .mockResolvedValueOnce(
        new Response('zip-content', {
          status: 200,
          headers: { 'Content-Disposition': "attachment; filename*=UTF-8''logs.zip" },
        }),
      );
    const refresh = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('fetch', fetchMock);
    configureApiClient({ getAccessToken: () => 'new-token', refreshAccessToken: refresh });

    const { apiBlobRequest } = await import('./client');
    const result = await apiBlobRequest('/tasks/task-id/artifacts/archive');
    expect(result.filename).toBe('logs.zip');
    expect(await result.blob.text()).toBe('zip-content');
    expect((fetchMock.mock.calls[1][1] as RequestInit).credentials).toBe('include');
    expect(
      ((fetchMock.mock.calls[1][1] as RequestInit).headers as Headers).get('Authorization'),
    ).toBe('Bearer new-token');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
