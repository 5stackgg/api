-- Loaded before hasura/functions/players, so these spell out the staff roles
-- and the block lookup instead of calling is_above_role / has_blocked_player:
-- a SQL function body is checked when it is created.

CREATE OR REPLACE FUNCTION public.news_comments_open(article_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.news_articles a
         WHERE a.id = news_comments_open.article_id
           AND a.status = 'published'
           AND a.published_at IS NOT NULL
           AND now() < a.published_at + interval '7 days'
    );
$$;

CREATE OR REPLACE FUNCTION public.news_comment_viewer(hasura_session json)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN hasura_session ->> 'x-hasura-user-id' ~ '^[0-9]{1,18}$'
            THEN (hasura_session ->> 'x-hasura-user-id')::bigint
    END;
$$;

CREATE OR REPLACE FUNCTION public.news_comment_text(
    comment public.news_comments,
    hasura_session json
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN comment.deleted_at IS NOT NULL THEN NULL
        WHEN comment.hidden_at IS NOT NULL
             AND COALESCE(hasura_session ->> 'x-hasura-role', '') NOT IN (
                 'moderator', 'match_organizer', 'tournament_organizer',
                 'administrator', 'admin'
             ) THEN NULL
        ELSE comment.body
    END;
$$;

-- A reader never sees what they blocked, a removed comment only while an
-- unhidden reply still hangs off it, or anything on a post that is not
-- published. Staff see every comment on a published post.
CREATE OR REPLACE FUNCTION public.news_comment_visible(
    comment public.news_comments,
    hasura_session json
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.news_articles a
         WHERE a.id = comment.article_id
           AND a.status = 'published'
    )
    AND (
        COALESCE(hasura_session ->> 'x-hasura-role', '') IN (
            'moderator', 'match_organizer', 'tournament_organizer',
            'administrator', 'admin'
        )
        OR (
            NOT EXISTS (
                SELECT 1
                  FROM public.player_blocks pb
                 WHERE pb.blocker_steam_id = public.news_comment_viewer(hasura_session)
                   AND pb.blocked_steam_id = comment.author_steam_id
            )
            AND (
                (comment.hidden_at IS NULL AND comment.deleted_at IS NULL)
                OR EXISTS (
                    SELECT 1
                      FROM public.news_comments reply
                     WHERE reply.parent_id = comment.id
                       AND reply.hidden_at IS NULL
                )
            )
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.news_comment_viewer_voted(
    comment public.news_comments,
    hasura_session json
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.news_comment_votes v
         WHERE v.comment_id = comment.id
           AND v.steam_id = public.news_comment_viewer(hasura_session)
    );
$$;

CREATE OR REPLACE FUNCTION public.news_comment_hidden_by_name(
    comment public.news_comments
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT p.name
      FROM public.players p
     WHERE p.steam_id = comment.hidden_by_steam_id;
$$;
