import type {
  FormConfigCompatibility,
  FormConfigValues,
  FormSchema,
} from '@buildplatform/contracts';

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
  formSchema: FormSchema;
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

export interface ProjectTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  agentId: string;
  enabled: boolean;
  agent: TemplateAgentSummary;
  formSchema?: FormSchema;
}

export interface ProjectView {
  id: string;
  ownerId: string;
  buildTemplateId: string;
  name: string;
  description: string | null;
  branch: string;
  config: FormConfigValues;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  owner: AuthUser;
  buildTemplate: ProjectTemplateSummary;
  configCompatibility: FormConfigCompatibility & {
    templateEnabled: boolean;
    agentEnabled: boolean;
    buildable: boolean;
  };
}

export interface ProjectPage {
  items: ProjectView[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ProjectListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  buildTemplateId?: string;
  ownerId?: string;
}

export interface ProjectCreateInput {
  name: string;
  description: string | null;
  buildTemplateId: string;
  branch: string;
  config: FormConfigValues;
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string | null;
  branch?: string;
}
