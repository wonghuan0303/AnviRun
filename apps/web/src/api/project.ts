import { apiRequest } from './client';
import type {
  ProjectCreateInput,
  ProjectListParams,
  ProjectPage,
  ProjectUpdateInput,
  ProjectView,
} from './types';

function queryString(params: ProjectListParams): string {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  if (params.search) query.set('search', params.search);
  if (params.buildTemplateId) query.set('buildTemplateId', params.buildTemplateId);
  if (params.ownerId) query.set('ownerId', params.ownerId);
  return query.toString() ? `?${query.toString()}` : '';
}

export function listProjects(params: ProjectListParams = {}): Promise<ProjectPage> {
  return apiRequest<ProjectPage>(`/projects${queryString(params)}`);
}

export function getProject(id: string): Promise<{ project: ProjectView }> {
  return apiRequest<{ project: ProjectView }>(`/projects/${id}`);
}

export function createProject(input: ProjectCreateInput): Promise<{ project: ProjectView }> {
  return apiRequest<{ project: ProjectView }>('/projects', {
    method: 'POST',
    body: input,
  });
}

export function updateProject(
  id: string,
  input: ProjectUpdateInput,
): Promise<{ project: ProjectView }> {
  return apiRequest<{ project: ProjectView }>(`/projects/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function saveProjectConfig(
  id: string,
  config: ProjectView['config'],
): Promise<{ project: ProjectView }> {
  return apiRequest<{ project: ProjectView }>(`/projects/${id}/config`, {
    method: 'PUT',
    body: { config },
  });
}

export function deleteProject(id: string): Promise<void> {
  return apiRequest<void>(`/projects/${id}`, { method: 'DELETE' });
}
