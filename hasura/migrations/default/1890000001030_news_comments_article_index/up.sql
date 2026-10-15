CREATE INDEX IF NOT EXISTS news_comments_article_parent_created_idx
    ON public.news_comments (article_id, parent_id, created_at);

DROP INDEX IF EXISTS public.news_comments_article_created_idx;
