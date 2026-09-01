-- T6.1: retain the phase interrupted by a short Agent disconnect and make
-- task creation safely repeatable for one user/project/idempotency key.
ALTER TABLE "BuildTask"
  ADD COLUMN "recoveryStatus" "BuildTaskStatus",
  ADD COLUMN "agentLostAt" TIMESTAMP(3),
  ADD COLUMN "recoveryDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "creationIdempotencyKey" VARCHAR(128);

CREATE UNIQUE INDEX "BuildTask_createdBy_projectId_creationIdempotencyKey_key"
  ON "BuildTask"("createdBy", "projectId", "creationIdempotencyKey");

CREATE INDEX "BuildTask_status_recoveryDeadlineAt_idx"
  ON "BuildTask"("status", "recoveryDeadlineAt");
