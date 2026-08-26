import { apiRequest } from './client';
import type { AgentMutationResponse, AgentPage, AgentSummary } from './types';

export interface AgentListParams {
  page?: number;
  pageSize?: number;
  search?: string;
}

export function listAgents(params: AgentListParams = {}): Promise<AgentPage> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
  if (params.search) query.set('search', params.search);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<AgentPage>(`/admin/agents${suffix}`);
}

export function createAgent(name: string): Promise<AgentMutationResponse> {
  return apiRequest<AgentMutationResponse>('/admin/agents', {
    method: 'POST',
    body: { name },
  });
}

export function updateAgent(id: string, name: string): Promise<{ agent: AgentSummary }> {
  return apiRequest<{ agent: AgentSummary }>(`/admin/agents/${id}`, {
    method: 'PATCH',
    body: { name },
  });
}

export function enableAgent(id: string): Promise<{ agent: AgentSummary }> {
  return apiRequest<{ agent: AgentSummary }>(`/admin/agents/${id}/enable`, { method: 'POST' });
}

export function disableAgent(id: string): Promise<{ agent: AgentSummary }> {
  return apiRequest<{ agent: AgentSummary }>(`/admin/agents/${id}/disable`, { method: 'POST' });
}

export function rotateAgentToken(id: string): Promise<AgentMutationResponse> {
  return apiRequest<AgentMutationResponse>(`/admin/agents/${id}/token/rotate`, {
    method: 'POST',
  });
}

export function deleteAgent(id: string): Promise<void> {
  return apiRequest<void>(`/admin/agents/${id}`, { method: 'DELETE' });
}
