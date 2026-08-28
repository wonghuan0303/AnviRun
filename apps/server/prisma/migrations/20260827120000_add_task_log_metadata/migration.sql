-- T5.1 keeps log content in files and only stores resumable offsets and
-- short-lived authorization metadata in PostgreSQL.
ALTER TABLE "public"."BuildTask"
  ADD COLUMN "lastLogSequence" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "logLeaseHash" VARCHAR(255),
  ADD COLUMN "logLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "logSensitiveKeys" JSONB;

CREATE INDEX "BuildTask_logLeaseExpiresAt_idx"
  ON "public"."BuildTask"("logLeaseExpiresAt");
