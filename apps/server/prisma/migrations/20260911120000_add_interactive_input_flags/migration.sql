ALTER TABLE "BuildTemplate" ADD COLUMN "interactiveInputEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BuildTask" ADD COLUMN "interactiveInputEnabled" BOOLEAN NOT NULL DEFAULT false;
