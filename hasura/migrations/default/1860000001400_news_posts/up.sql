TRUNCATE TABLE "public"."news_articles";

ALTER TABLE "public"."news_articles" DROP CONSTRAINT IF EXISTS "news_articles_url_key";

DROP INDEX IF EXISTS "public"."news_articles_source_idx";

ALTER TABLE "public"."news_articles"
  DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "issue_number",
  DROP COLUMN IF EXISTS "url",
  DROP COLUMN IF EXISTS "content_html",
  DROP COLUMN IF EXISTS "scraped_at",
  DROP COLUMN IF EXISTS "author";

ALTER TABLE "public"."news_articles"
  ADD COLUMN IF NOT EXISTS "content_markdown" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "author_steam_id" bigint;

ALTER TABLE "public"."news_articles"
  ADD CONSTRAINT "news_articles_status_check" CHECK ("status" IN ('draft', 'published'));

ALTER TABLE "public"."news_articles"
  ADD CONSTRAINT "news_articles_author_steam_id_fkey"
  FOREIGN KEY ("author_steam_id") REFERENCES "public"."players" ("steam_id")
  ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "public"."news_articles" ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "news_articles_slug_key" ON "public"."news_articles" ("slug");
CREATE INDEX IF NOT EXISTS "news_articles_status_published_at_idx" ON "public"."news_articles" ("status", "published_at" DESC);
