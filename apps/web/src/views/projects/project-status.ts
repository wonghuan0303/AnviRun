import type { AgentStatus, ProjectView } from '@/api/types';

export function effectiveAgentStatus(agent: {
  enabled: boolean;
  status: AgentStatus;
}): AgentStatus {
  return agent.enabled ? agent.status : 'DISABLED';
}

export function agentStatusLabel(agent: { enabled: boolean; status: AgentStatus }): string {
  const status = effectiveAgentStatus(agent);
  return status === 'ONLINE' ? '在线' : status === 'OFFLINE' ? '离线' : '已停用';
}

export function agentStatusType(agent: {
  enabled: boolean;
  status: AgentStatus;
}): 'success' | 'warning' | 'info' | 'danger' {
  const status = effectiveAgentStatus(agent);
  return status === 'ONLINE' ? 'success' : status === 'OFFLINE' ? 'warning' : 'danger';
}

export function compatibilityLabel(project: ProjectView): string {
  if (!project.configCompatibility.valid) return '配置不兼容';
  return project.configCompatibility.buildable ? '可构建' : '暂不可构建';
}

export function compatibilityType(project: ProjectView): 'success' | 'warning' | 'danger' {
  if (!project.configCompatibility.valid) return 'danger';
  return project.configCompatibility.buildable ? 'success' : 'warning';
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}
