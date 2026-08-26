import { apiRequest } from './client';
import type { BuildTemplateAdminView, BuildTemplatePage, BuildTemplatePublicView } from './types';

export interface BuildTemplateListParams {
  page?: number;
  pageSize?: number;
  enabled?: boolean;
  agentId?: string;
  search?: string;
}

function queryString(params: BuildTemplateListParams): string {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  if (params.enabled !== undefined) query.set('enabled', String(params.enabled));
  if (params.agentId) query.set('agentId', params.agentId);
  if (params.search) query.set('search', params.search);
  return query.toString() ? `?${query.toString()}` : '';
}

export function listBuildTemplates(
  params: BuildTemplateListParams = {},
): Promise<BuildTemplatePage> {
  return apiRequest<BuildTemplatePage>(`/admin/build-templates${queryString(params)}`);
}

export function getBuildTemplate(id: string): Promise<{ template: BuildTemplateAdminView }> {
  return apiRequest<{ template: BuildTemplateAdminView }>(`/admin/build-templates/${id}`);
}

export type BuildTemplateInput = Omit<
  BuildTemplateAdminView,
  'id' | 'enabled' | 'createdBy' | 'createdAt' | 'updatedAt' | 'agent'
> & { formSchema: unknown };

export function createBuildTemplate(
  input: BuildTemplateInput,
): Promise<{ template: BuildTemplateAdminView }> {
  return apiRequest<{ template: BuildTemplateAdminView }>('/admin/build-templates', {
    method: 'POST',
    body: input,
  });
}

export function updateBuildTemplate(
  id: string,
  input: Partial<BuildTemplateInput>,
): Promise<{ template: BuildTemplateAdminView }> {
  return apiRequest<{ template: BuildTemplateAdminView }>(`/admin/build-templates/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function enableBuildTemplate(id: string): Promise<{ template: BuildTemplateAdminView }> {
  return apiRequest<{ template: BuildTemplateAdminView }>(`/admin/build-templates/${id}/enable`, {
    method: 'POST',
  });
}

export function disableBuildTemplate(id: string): Promise<{ template: BuildTemplateAdminView }> {
  return apiRequest<{ template: BuildTemplateAdminView }>(`/admin/build-templates/${id}/disable`, {
    method: 'POST',
  });
}

export function deleteBuildTemplate(id: string): Promise<void> {
  return apiRequest<void>(`/admin/build-templates/${id}`, { method: 'DELETE' });
}

export interface PublicBuildTemplateListParams {
  page?: number;
  pageSize?: number;
}

export function listPublicBuildTemplates(
  params: PublicBuildTemplateListParams = {},
): Promise<BuildTemplatePage<BuildTemplatePublicView>> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<BuildTemplatePage<BuildTemplatePublicView>>(`/build-templates${suffix}`);
}
