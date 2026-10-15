DROP FUNCTION IF EXISTS public.news_comment_text(public.news_comments, json);
DROP FUNCTION IF EXISTS public.news_comment_visible(public.news_comments, json);
DROP FUNCTION IF EXISTS public.news_comment_viewer_voted(public.news_comments, json);
DROP FUNCTION IF EXISTS public.news_comment_hidden_by_name(public.news_comments);

DROP TABLE IF EXISTS public.news_comment_votes;
DROP TABLE IF EXISTS public.news_comments;

DROP FUNCTION IF EXISTS public.tbi_news_comments();
DROP FUNCTION IF EXISTS public.tbu_news_comments();
DROP FUNCTION IF EXISTS public.tbi_news_comment_votes();
DROP FUNCTION IF EXISTS public.tbd_news_comment_votes();
DROP FUNCTION IF EXISTS public.tai_news_comment_votes();
DROP FUNCTION IF EXISTS public.tad_news_comment_votes();
DROP FUNCTION IF EXISTS public.news_comments_open(uuid);
DROP FUNCTION IF EXISTS public.news_comment_viewer(json);

DELETE FROM public.notifications WHERE type = 'NewsCommentReply';

-- The boot loader skips a functions or triggers file whose digest is unchanged,
-- so a forward deploy after this rollback would bring the tables back without
-- them.
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE replace(name, chr(92), '/') IN (
      'hasura/functions/news/news_comments',
      'hasura/triggers/news_comments'
    );
  END IF;
END $$;
