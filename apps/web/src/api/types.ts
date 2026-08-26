export type UserRole = 'ADMIN' | 'USER';
export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
}

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

export type AgentStatus = 'ONLINE' | 'OFFLINE' | 'DISABLED';

export interface AgentSummary {
  id: string;
  name: string;
  enabled: boolean;
  status: AgentStatus;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  version: string | null;
  lastSeenAt: string | null;
  activeTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPage {
  items: AgentSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AgentMutationResponse {
  agent: AgentSummary;
  registrationToken?: string;
}

export interface TemplateAgentSummary {
  id: string;
  name: string;
  enabled: boolean;
  status: AgentStatus;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  version: string | null;
  lastSeenAt: string | null;
}

export interface BuildTemplateAdminView {
  id: string;
  name: string;
  description: string | null;
  agentId: string;
  gitUrl: string;
  command: string;
  artifactDir: string;
  formSchema: unknown;
  timeoutSeconds: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  agent: TemplateAgentSummary;
}

export interface BuildTemplatePublicView {
  id: string;
  name: string;
  description: string | null;
  agentId: string;
  gitUrl: string;
  formSchema: unknown;
  timeoutSeconds: number;
  enabled: true;
  agent: TemplateAgentSummary;
}

export interface BuildTemplatePage<T = BuildTemplateAdminView> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
