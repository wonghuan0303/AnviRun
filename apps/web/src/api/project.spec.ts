import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import { createProject, listProjects, saveProjectConfig } from './project';

vi.mock('./client', () => ({ apiRequest: vi.fn() }));

describe('project API', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    vi.mocked(apiRequest).mockResolvedValue({} as never);
  });

  it('serializes list filters as server query parameters', async () => {
    await listProjects({
      page: 2,
      pageSize: 10,
      search: 'demo project',
      buildTemplateId: 'template-id',
      ownerId: 'owner-id',
    });

    expect(apiRequest).toHaveBeenCalledWith(
      '/projects?page=2&pageSize=10&search=demo+project&buildTemplateId=template-id&ownerId=owner-id',
    );
  });

  it('sends config through the dedicated endpoint without an owner field', async () => {
    const config = { branch: 'main' };
    await saveProjectConfig('project-id', config);

    expect(apiRequest).toHaveBeenCalledWith('/projects/project-id/config', {
      method: 'PUT',
      body: { config },
    });
  });

  it('creates projects with only the supported input fields', async () => {
    await createProject({
      name: 'Demo',
      description: null,
      buildTemplateId: 'template-id',
      branch: 'main',
      config: {},
    });

    expect(apiRequest).toHaveBeenCalledWith('/projects', {
      method: 'POST',
      body: {
        name: 'Demo',
        description: null,
        buildTemplateId: 'template-id',
        branch: 'main',
        config: {},
      },
    });
  });
});
