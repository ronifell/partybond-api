-- Optional image attachments on user reports (screenshots, evidence).

ALTER TABLE "user_reports"
  ADD COLUMN IF NOT EXISTS "attachment_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
