CREATE INDEX IF NOT EXISTS news_comments_article_created_idx
    ON public.news_comments (article_id, created_at DESC)
    WHERE parent_id IS NULL;

DROP INDEX IF EXISTS public.news_comments_article_parent_created_idx;
