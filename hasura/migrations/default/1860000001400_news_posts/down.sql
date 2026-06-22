DROP INDEX IF EXISTS "public"."news_articles_status_published_at_idx";
DROP INDEX IF EXISTS "public"."news_articles_slug_key";

ALTER TABLE "public"."news_articles" DROP CONSTRAINT IF EXISTS "news_articles_author_steam_id_fkey";
ALTER TABLE "public"."news_articles" DROP CONSTRAINT IF EXISTS "news_articles_status_check";

ALTER TABLE "public"."news_articles" ALTER COLUMN "slug" DROP NOT NULL;

ALTER TABLE "public"."news_articles"
  DROP COLUMN IF EXISTS "content_markdown",
  DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "author_steam_id";

ALTER TABLE "public"."news_articles"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'tldr',
  ADD COLUMN IF NOT EXISTS "issue_number" integer,
  ADD COLUMN IF NOT EXISTS "url" text,
  ADD COLUMN IF NOT EXISTS "content_html" text,
  ADD COLUMN IF NOT EXISTS "scraped_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "author" text;

CREATE INDEX IF NOT EXISTS "news_articles_source_idx" ON "public"."news_articles" ("source");
