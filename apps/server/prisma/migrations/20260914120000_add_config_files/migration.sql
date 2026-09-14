CREATE TABLE "public"."ConfigFile" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "projectId" UUID,
  "buildTemplateId" UUID NOT NULL,
  "fieldName" VARCHAR(64) NOT NULL,
  "originalName" VARCHAR(512) NOT NULL,
  "size" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "storagePath" VARCHAR(4096) NOT NULL,
  "contentType" VARCHAR(255),
  "expiresAt" TIMESTAMP(3),
  "detachedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfigFile_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "public"."BuildTaskInputFile" (
  "id" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "configFileId" UUID NOT NULL,
  "fieldName" VARCHAR(64) NOT NULL,
  "targetRelativePath" VARCHAR(2048) NOT NULL,
  "originalName" VARCHAR(512) NOT NULL,
  "size" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BuildTaskInputFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConfigFile_ownerId_expiresAt_idx" ON "public"."ConfigFile"("ownerId", "expiresAt");
CREATE INDEX "ConfigFile_projectId_fieldName_idx" ON "public"."ConfigFile"("projectId", "fieldName");
CREATE INDEX "ConfigFile_buildTemplateId_fieldName_idx" ON "public"."ConfigFile"("buildTemplateId", "fieldName");
CREATE UNIQUE INDEX "BuildTaskInputFile_taskId_fieldName_key" ON "public"."BuildTaskInputFile"("taskId", "fieldName");
CREATE INDEX "BuildTaskInputFile_configFileId_idx" ON "public"."BuildTaskInputFile"("configFileId");
ALTER TABLE "public"."ConfigFile" ADD CONSTRAINT "ConfigFile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "public"."ConfigFile" ADD CONSTRAINT "ConfigFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "public"."ConfigFile" ADD CONSTRAINT "ConfigFile_buildTemplateId_fkey" FOREIGN KEY ("buildTemplateId") REFERENCES "public"."BuildTemplate"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "public"."BuildTaskInputFile" ADD CONSTRAINT "BuildTaskInputFile_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "public"."BuildTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."BuildTaskInputFile" ADD CONSTRAINT "BuildTaskInputFile_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "public"."ConfigFile"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
