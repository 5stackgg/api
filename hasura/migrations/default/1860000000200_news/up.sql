CREATE TABLE IF NOT EXISTS "public"."news_articles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "source" text NOT NULL DEFAULT 'tldr',
  "issue_number" integer,
  "slug" text,
  "url" text NOT NULL,
  "title" text NOT NULL,
  "teaser" text,
  "content_html" text,
  "cover_image_url" text,
  "author" text,
  "published_at" timestamptz,
  "scraped_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "news_articles_url_key" UNIQUE ("url")
);

CREATE INDEX IF NOT EXISTS "news_articles_published_at_idx" ON "public"."news_articles" ("published_at" DESC);
CREATE INDEX IF NOT EXISTS "news_articles_source_idx" ON "public"."news_articles" ("source");

ALTER TABLE "public"."players" ADD COLUMN IF NOT EXISTS "last_read_news_at" timestamptz;
