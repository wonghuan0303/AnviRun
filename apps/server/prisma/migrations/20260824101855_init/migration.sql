-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "public"."AgentStatus" AS ENUM ('ONLINE', 'OFFLINE', 'DISABLED');

-- CreateEnum
CREATE TYPE "public"."BuildTaskStatus" AS ENUM ('CREATED', 'WAITING_AGENT', 'QUEUED', 'DISPATCHED', 'PREPARING', 'RUNNING', 'UPLOADING', 'SUCCEEDED', 'FAILED', 'CANCELING', 'CANCELED', 'AGENT_LOST');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "public"."UserRole" NOT NULL DEFAULT 'USER',
    "status" "public"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "clientSummary" VARCHAR(255),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Agent" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "tokenHash" VARCHAR(255),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "public"."AgentStatus" NOT NULL DEFAULT 'OFFLINE',
    "hostname" VARCHAR(255),
    "os" VARCHAR(64),
    "arch" VARCHAR(64),
    "version" VARCHAR(64),
    "lastSeenAt" TIMESTAMP(3),
    "activeTaskId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BuildTemplate" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "agentId" UUID NOT NULL,
    "gitUrl" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "artifactDir" VARCHAR(1024) NOT NULL,
    "formSchema" JSONB NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 3600,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Project" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "buildTemplateId" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "branch" VARCHAR(512) NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BuildTask" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "buildTemplateId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "createdBy" UUID NOT NULL,
    "status" "public"."BuildTaskStatus" NOT NULL DEFAULT 'CREATED',
    "statusReason" TEXT,
    "branch" VARCHAR(512) NOT NULL,
    "config" JSONB NOT NULL,
    "sourceCommit" VARCHAR(128),
    "exitCode" INTEGER,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "leaseHash" VARCHAR(255),
    "leaseExpiresAt" TIMESTAMP(3),
    "logSize" BIGINT NOT NULL DEFAULT 0,
    "artifactCount" BIGINT NOT NULL DEFAULT 0,
    "artifactBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Artifact" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "relativePath" VARCHAR(2048) NOT NULL,
    "fileName" VARCHAR(512) NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storagePath" VARCHAR(4096) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(128) NOT NULL,
    "resourceType" VARCHAR(128) NOT NULL,
    "resourceId" VARCHAR(128) NOT NULL,
    "requestId" VARCHAR(128),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- Usernames are stored in canonical lowercase form; application code normalizes before writes.
ALTER TABLE "public"."User" ADD CONSTRAINT "User_username_lowercase_ck" CHECK ("username" = lower("username"));

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "public"."User"("username");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "public"."User"("role");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "public"."User"("status");

-- CreateIndex
CREATE INDEX "User_status_createdAt_id_idx" ON "public"."User"("status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "public"."RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "public"."RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "public"."RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "RefreshToken_revokedAt_idx" ON "public"."RefreshToken"("revokedAt");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_revokedAt_expiresAt_idx" ON "public"."RefreshToken"("userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_name_key" ON "public"."Agent"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_tokenHash_key" ON "public"."Agent"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_activeTaskId_key" ON "public"."Agent"("activeTaskId");

-- CreateIndex
CREATE INDEX "Agent_status_idx" ON "public"."Agent"("status");

-- CreateIndex
CREATE INDEX "Agent_enabled_status_idx" ON "public"."Agent"("enabled", "status");

-- CreateIndex
CREATE INDEX "Agent_lastSeenAt_idx" ON "public"."Agent"("lastSeenAt");

-- CreateIndex
CREATE INDEX "BuildTemplate_agentId_idx" ON "public"."BuildTemplate"("agentId");

-- CreateIndex
CREATE INDEX "BuildTemplate_enabled_updatedAt_idx" ON "public"."BuildTemplate"("enabled", "updatedAt");

-- CreateIndex
CREATE INDEX "BuildTemplate_createdBy_idx" ON "public"."BuildTemplate"("createdBy");

-- CreateIndex
CREATE UNIQUE INDEX "BuildTemplate_agentId_name_key" ON "public"."BuildTemplate"("agentId", "name");

-- CreateIndex
CREATE INDEX "Project_ownerId_deletedAt_createdAt_id_idx" ON "public"."Project"("ownerId", "deletedAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Project_buildTemplateId_idx" ON "public"."Project"("buildTemplateId");

-- CreateIndex
CREATE INDEX "Project_ownerId_name_idx" ON "public"."Project"("ownerId", "name");

-- A single Agent may queue many tasks, but only one task may occupy an execution slot.
-- Prisma schema cannot express this PostgreSQL partial unique index, so it is maintained in migration SQL.
CREATE UNIQUE INDEX "BuildTask_agent_execution_slot_unique"
  ON "public"."BuildTask" ("agentId")
  WHERE "status" IN ('DISPATCHED', 'PREPARING', 'RUNNING', 'UPLOADING', 'CANCELING', 'AGENT_LOST');

-- CreateIndex
CREATE INDEX "BuildTask_projectId_createdAt_id_idx" ON "public"."BuildTask"("projectId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "BuildTask_agentId_status_createdAt_id_idx" ON "public"."BuildTask"("agentId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "BuildTask_status_createdAt_id_idx" ON "public"."BuildTask"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "BuildTask_buildTemplateId_status_createdAt_id_idx" ON "public"."BuildTask"("buildTemplateId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "BuildTask_createdBy_createdAt_id_idx" ON "public"."BuildTask"("createdBy", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Artifact_taskId_deletedAt_createdAt_id_idx" ON "public"."Artifact"("taskId", "deletedAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Artifact_deletedAt_createdAt_idx" ON "public"."Artifact"("deletedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_taskId_relativePath_key" ON "public"."Artifact"("taskId", "relativePath");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "public"."AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "public"."AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_createdAt_idx" ON "public"."AuditLog"("resourceType", "resourceId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Agent" ADD CONSTRAINT "Agent_activeTaskId_fkey" FOREIGN KEY ("activeTaskId") REFERENCES "public"."BuildTask"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuildTemplate" ADD CONSTRAINT "BuildTemplate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuildTemplate" ADD CONSTRAINT "BuildTemplate_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "public"."User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Project" ADD CONSTRAINT "Project_buildTemplateId_fkey" FOREIGN KEY ("buildTemplateId") REFERENCES "public"."BuildTemplate"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuildTask" ADD CONSTRAINT "BuildTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuildTask" ADD CONSTRAINT "BuildTask_buildTemplateId_fkey" FOREIGN KEY ("buildTemplateId") REFERENCES "public"."BuildTemplate"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuildTask" ADD CONSTRAINT "BuildTask_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuildTask" ADD CONSTRAINT "BuildTask_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "public"."User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Artifact" ADD CONSTRAINT "Artifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "public"."BuildTask"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
