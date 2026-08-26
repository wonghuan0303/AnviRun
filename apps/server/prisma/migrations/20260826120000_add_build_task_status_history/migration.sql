-- CreateTable
CREATE TABLE "public"."BuildTaskStatusHistory" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "fromStatus" "public"."BuildTaskStatus",
    "toStatus" "public"."BuildTaskStatus" NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildTaskStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuildTaskStatusHistory_taskId_occurredAt_id_idx"
  ON "public"."BuildTaskStatusHistory"("taskId", "occurredAt", "id");

-- AddForeignKey
ALTER TABLE "public"."BuildTaskStatusHistory"
  ADD CONSTRAINT "BuildTaskStatusHistory_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "public"."BuildTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;