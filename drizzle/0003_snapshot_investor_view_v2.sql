ALTER TABLE "snapshots"
ADD COLUMN "investor_view_v2" jsonb NOT NULL DEFAULT '{}'::jsonb;

