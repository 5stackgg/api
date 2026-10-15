-- A reply to a reply is moved up to the top-level comment: replies go one
-- level deep.
CREATE OR REPLACE FUNCTION public.tbi_news_comments()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    parent public.news_comments;
BEGIN
    IF NOT public.news_comments_open(NEW.article_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_closed';
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
        SELECT * INTO parent
          FROM public.news_comments
         WHERE id = NEW.parent_id;

        IF parent.parent_id IS NOT NULL THEN
            SELECT * INTO parent
              FROM public.news_comments
             WHERE id = parent.parent_id;
        END IF;

        IF parent.id IS NULL OR parent.article_id <> NEW.article_id THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_not_found';
        END IF;

        IF parent.deleted_at IS NOT NULL OR parent.hidden_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_parent_removed';
        END IF;

        NEW.parent_id := parent.id;
    END IF;

    NEW.body := btrim(NEW.body);
    NEW.vote_count := 0;
    NEW.created_at := now();
    NEW.edited_at := NULL;
    NEW.deleted_at := NULL;
    NEW.deleted_by_staff := false;
    NEW.hidden_at := NULL;
    NEW.hidden_by_steam_id := NULL;
    NEW.hidden_reason := NULL;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_news_comments ON public.news_comments;
CREATE TRIGGER tbi_news_comments
    BEFORE INSERT ON public.news_comments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_news_comments();

-- Deleting, hiding and restoring stay allowed after the thread closes; only
-- the text is held to the 10-minute edit window.
CREATE OR REPLACE FUNCTION public.tbu_news_comments()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.article_id IS DISTINCT FROM OLD.article_id
       OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
       OR NEW.author_steam_id IS DISTINCT FROM OLD.author_steam_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_immutable';
    END IF;

    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_removed';
    END IF;

    IF NEW.body IS DISTINCT FROM OLD.body THEN
        IF OLD.deleted_at IS NOT NULL OR OLD.hidden_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_removed';
        END IF;

        IF now() > OLD.created_at + interval '10 minutes' THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_edit_window';
        END IF;

        NEW.body := btrim(NEW.body);
        NEW.edited_at := now();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_news_comments ON public.news_comments;
CREATE TRIGGER tbu_news_comments
    BEFORE UPDATE ON public.news_comments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_news_comments();

CREATE OR REPLACE FUNCTION public.tbi_news_comment_votes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    comment public.news_comments;
BEGIN
    SELECT * INTO comment
      FROM public.news_comments
     WHERE id = NEW.comment_id;

    IF comment.author_steam_id = NEW.steam_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_own_vote';
    END IF;

    IF comment.deleted_at IS NOT NULL OR comment.hidden_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_removed';
    END IF;

    IF NOT public.news_comments_open(comment.article_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_closed';
    END IF;

    NEW.created_at := now();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_news_comment_votes ON public.news_comment_votes;
CREATE TRIGGER tbi_news_comment_votes
    BEFORE INSERT ON public.news_comment_votes
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_news_comment_votes();

-- A +1 removed by a cascade (its comment, post or player going) arrives from
-- inside the foreign key's own trigger, at a depth above 1, and is never held
-- to the thread closing.
CREATE OR REPLACE FUNCTION public.tbd_news_comment_votes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    article uuid;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;

    SELECT article_id INTO article
      FROM public.news_comments
     WHERE id = OLD.comment_id;

    IF article IS NOT NULL AND NOT public.news_comments_open(article) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'news_comment_closed';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_news_comment_votes ON public.news_comment_votes;
CREATE TRIGGER tbd_news_comment_votes
    BEFORE DELETE ON public.news_comment_votes
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_news_comment_votes();

CREATE OR REPLACE FUNCTION public.tai_news_comment_votes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.news_comments
       SET vote_count = vote_count + 1
     WHERE id = NEW.comment_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_news_comment_votes ON public.news_comment_votes;
CREATE TRIGGER tai_news_comment_votes
    AFTER INSERT ON public.news_comment_votes
    FOR EACH ROW
    EXECUTE FUNCTION public.tai_news_comment_votes();

CREATE OR REPLACE FUNCTION public.tad_news_comment_votes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.news_comments
       SET vote_count = GREATEST(vote_count - 1, 0)
     WHERE id = OLD.comment_id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_news_comment_votes ON public.news_comment_votes;
CREATE TRIGGER tad_news_comment_votes
    AFTER DELETE ON public.news_comment_votes
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_news_comment_votes();
