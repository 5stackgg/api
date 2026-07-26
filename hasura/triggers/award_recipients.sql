-- Duplicate protection for hand-granted awards. This cannot be a partial
-- unique index: whether repeats are allowed lives on awards.allow_multiple.
--
-- The partial unique keys on (tournament_id, tournament_team_id, recipient,
-- placement) only bind when every column is present, so they do not cover a
-- hand-granted row — those carry a NULL placement, and a NULL
-- tournament_team_id whenever the recipient never appeared on a roster. NULLs
-- are distinct in a unique index, so without this trigger the same award could
-- be granted to the same recipient repeatedly.
CREATE OR REPLACE FUNCTION public.tbi_award_recipients() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _allow_multiple boolean;
BEGIN
    IF NEW.source IS DISTINCT FROM 'manual' THEN
        RETURN NEW;
    END IF;

    SELECT allow_multiple INTO _allow_multiple
    FROM public.awards WHERE id = NEW.award_id;

    IF _allow_multiple IS DISTINCT FROM false THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.award_recipients existing
        WHERE existing.award_id = NEW.award_id
          AND existing.source = 'manual'
          AND existing.tournament_id IS NOT DISTINCT FROM NEW.tournament_id
          AND existing.id IS DISTINCT FROM NEW.id
          AND (
              (NEW.player_steam_id IS NOT NULL AND existing.player_steam_id = NEW.player_steam_id)
              OR (NEW.team_id IS NOT NULL AND existing.team_id = NEW.team_id)
          )
    ) THEN
        RAISE EXCEPTION 'Award already granted to this recipient';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_award_recipients ON public.award_recipients;
CREATE TRIGGER tbi_award_recipients
    BEFORE INSERT ON public.award_recipients
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_award_recipients();
