import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import {
  createAdminUser,
  disableAdminUser,
  enableAdminUser,
  listAdminUsers,
  resetAdminUserPassword,
} from './users';

vi.mock('./client', () => ({ apiRequest: vi.fn() }));

describe('users api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes list filters without including empty values', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({});

    await listAdminUsers({ page: 2, pageSize: 20, search: 'Admin User', role: 'ADMIN' });

    expect(apiRequest).toHaveBeenCalledWith(
      '/admin/users?page=2&pageSize=20&search=Admin+User&role=ADMIN',
    );
  });

  it('uses the administrator mutation endpoints', async () => {
    vi.mocked(apiRequest).mockResolvedValue({});

    await createAdminUser({ username: 'new-user', password: 'safe password', role: 'USER' });
    await enableAdminUser('user-id');
    await disableAdminUser('user-id');
    await resetAdminUserPassword('user-id', 'new safe password');

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/admin/users', {
      method: 'POST',
      body: { username: 'new-user', password: 'safe password', role: 'USER' },
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/admin/users/user-id/enable', {
      method: 'POST',
    });
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/admin/users/user-id/disable', {
      method: 'PATCH',
    });
    expect(apiRequest).toHaveBeenNthCalledWith(4, '/admin/users/user-id/reset-password', {
      method: 'POST',
      body: { password: 'new safe password' },
    });
  });
});
