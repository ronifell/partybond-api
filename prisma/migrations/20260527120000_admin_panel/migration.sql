-- Admin panel additions: admin flag + ban tracking on users, report triage on reports.

-- Users: admin + ban tracking
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "is_admin"   BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "banned_at"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ban_reason" TEXT;

-- Report triage
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportStatus') THEN
    CREATE TYPE "ReportStatus" AS ENUM ('open', 'reviewed', 'dismissed');
  END IF;
END$$;

ALTER TABLE "user_reports"
  ADD COLUMN IF NOT EXISTS "status"         "ReportStatus" NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS "admin_note"     TEXT,
  ADD COLUMN IF NOT EXISTS "resolved_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resolved_by_id" TEXT;

CREATE INDEX IF NOT EXISTS "user_reports_status_created_at_idx"
  ON "user_reports" ("status", "created_at");
