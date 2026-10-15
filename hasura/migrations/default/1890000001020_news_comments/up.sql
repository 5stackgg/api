CREATE TABLE IF NOT EXISTS public.news_comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id uuid NOT NULL
        REFERENCES public.news_articles(id) ON DELETE CASCADE,
    parent_id uuid
        REFERENCES public.news_comments(id) ON DELETE CASCADE,
    author_steam_id bigint NOT NULL
        REFERENCES public.players(steam_id) ON DELETE CASCADE,
    body text NOT NULL
        CONSTRAINT news_comments_body_length
        CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
    vote_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    deleted_by_staff boolean NOT NULL DEFAULT false,
    hidden_at timestamptz,
    hidden_by_steam_id bigint
        REFERENCES public.players(steam_id) ON DELETE SET NULL,
    hidden_reason text
        CONSTRAINT news_comments_hidden_reason_length
        CHECK (char_length(hidden_reason) <= 500)
);

CREATE INDEX IF NOT EXISTS news_comments_article_created_idx
    ON public.news_comments (article_id, created_at DESC)
    WHERE parent_id IS NULL;

CREATE INDEX IF NOT EXISTS news_comments_parent_created_idx
    ON public.news_comments (parent_id, created_at)
    WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS news_comments_author_idx
    ON public.news_comments (author_steam_id);

CREATE INDEX IF NOT EXISTS news_comments_hidden_by_idx
    ON public.news_comments (hidden_by_steam_id)
    WHERE hidden_by_steam_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.news_comment_votes (
    comment_id uuid NOT NULL
        REFERENCES public.news_comments(id) ON DELETE CASCADE,
    steam_id bigint NOT NULL
        REFERENCES public.players(steam_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, steam_id)
);

CREATE INDEX IF NOT EXISTS news_comment_votes_steam_id_idx
    ON public.news_comment_votes (steam_id);
