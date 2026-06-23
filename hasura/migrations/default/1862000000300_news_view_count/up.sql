ALTER TABLE "public"."news_articles"
  ADD COLUMN IF NOT EXISTS "view_count" bigint NOT NULL DEFAULT 0;
