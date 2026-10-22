-- Keeps teams.last_match_at (migration 1890000001200) equal to the latest of
-- each started match's end, or start while it is still going, across every
-- lineup the team played as.
CREATE OR REPLACE FUNCTION public.recompute_team_last_match_at(_team_id uuid)
RETURNS void
LANGUAGE sql
AS $$
    UPDATE public.teams t
    SET last_match_at = s.last_match_at
    FROM (
        SELECT max(COALESCE(m.ended_at, m.started_at)) AS last_match_at
        FROM public.match_lineups ml
        INNER JOIN public.matches m ON m.id = ml.match_id
        WHERE ml.team_id = _team_id
          AND m.started_at IS NOT NULL
    ) s
    WHERE t.id = _team_id
      AND t.last_match_at IS DISTINCT FROM s.last_match_at;
$$;

CREATE OR REPLACE FUNCTION public.taiud_match_lineups_team_last_match_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.team_id IS NOT NULL THEN
        PERFORM public.recompute_team_last_match_at(OLD.team_id);
    END IF;

    IF TG_OP <> 'DELETE'
       AND NEW.team_id IS NOT NULL
       AND NEW.match_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.team_id IS DISTINCT FROM OLD.team_id) THEN
        PERFORM public.recompute_team_last_match_at(NEW.team_id);
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taiud_match_lineups_team_last_match_at ON public.match_lineups;
CREATE TRIGGER taiud_match_lineups_team_last_match_at
    AFTER INSERT OR UPDATE OF team_id, match_id OR DELETE ON public.match_lineups
    FOR EACH ROW EXECUTE FUNCTION public.taiud_match_lineups_team_last_match_at();

CREATE OR REPLACE FUNCTION public.tau_matches_team_last_match_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _team_id uuid;
BEGIN
    FOR _team_id IN
        SELECT DISTINCT ml.team_id
        FROM public.match_lineups ml
        WHERE ml.match_id = NEW.id
          AND ml.team_id IS NOT NULL
    LOOP
        PERFORM public.recompute_team_last_match_at(_team_id);
    END LOOP;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_matches_team_last_match_at ON public.matches;
CREATE TRIGGER tau_matches_team_last_match_at
    AFTER UPDATE OF started_at, ended_at ON public.matches
    FOR EACH ROW
    WHEN (
        OLD.started_at IS DISTINCT FROM NEW.started_at
        OR OLD.ended_at IS DISTINCT FROM NEW.ended_at
    )
    EXECUTE FUNCTION public.tau_matches_team_last_match_at();
