import type { FormConfigCompatibility, FormConfigValues, FormSchema } from '@anvilrun/contracts';

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

export type BuildTaskStatus =
  | 'CREATED'
  | 'WAITING_AGENT'
  | 'QUEUED'
  | 'DISPATCHED'
  | 'PREPARING'
  | 'RUNNING'
  | 'UPLOADING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELING'
  | 'CANCELED'
  | 'AGENT_LOST';

export interface TaskStatusHistory {
  id: string;
  fromStatus: BuildTaskStatus | null;
  toStatus: BuildTaskStatus;
  source: string;
  reason: string | null;
  occurredAt: string;
}

export interface TaskProjectSummary {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  branch: string;
  owner: AuthUser;
}

export interface TaskTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  agentId: string;
  enabled: boolean;
  agent: TemplateAgentSummary;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  buildTemplateId: string;
  agentId: string;
  createdBy: string;
  status: BuildTaskStatus;
  statusReason: string | null;
  branch: string;
  config: Record<string, unknown>;
  sourceCommit: string | null;
  exitCode: number | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  leaseExpiresAt: string | null;
  logSize: string;
  artifactCount: string;
  artifactBytes: string;
  createdAt: string;
  updatedAt: string;
  project: TaskProjectSummary;
  buildTemplate: TaskTemplateSummary;
  agent: TemplateAgentSummary;
  creator: AuthUser;
}

export interface TaskDetail extends TaskSummary {
  statusHistory: TaskStatusHistory[];
}

export interface TaskPage {
  items: TaskSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface TaskLogEntry {
  sequence: number;
  stream: 'stdout' | 'stderr';
  chunk: string;
  emittedAt: string;
}

export interface TaskLogPage {
  taskId: string;
  offset: number;
  nextOffset: number;
  size: number;
  eof: boolean;
  entries: TaskLogEntry[];
}

export interface ArtifactSummary {
  id: string;
  taskId: string;
  relativePath: string;
  fileName: string;
  size: string;
  sha256: string;
  createdAt: string;
}

export interface ArtifactPage {
  items: ArtifactSummary[];
  taskId: string;
  page: number;
  pageSize: number;
  total: number;
}
