-- Keeps match_lineups.display_name (migration 1890000001400) equal to what
-- compute_match_lineup_name answers, from every table it reads.

CREATE OR REPLACE FUNCTION public.taiu_match_lineups_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM public.refresh_match_lineup_names(ARRAY[NEW.id]);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_lineups_name ON public.match_lineups;
CREATE TRIGGER tai_match_lineups_name
    AFTER INSERT ON public.match_lineups
    FOR EACH ROW EXECUTE FUNCTION public.taiu_match_lineups_name();

DROP TRIGGER IF EXISTS tau_match_lineups_name ON public.match_lineups;
CREATE TRIGGER tau_match_lineups_name
    AFTER UPDATE OF team_name, team_id, match_id ON public.match_lineups
    FOR EACH ROW
    WHEN (OLD.team_name IS DISTINCT FROM NEW.team_name
       OR OLD.team_id IS DISTINCT FROM NEW.team_id
       OR OLD.match_id IS DISTINCT FROM NEW.match_id)
    EXECUTE FUNCTION public.taiu_match_lineups_name();

CREATE OR REPLACE FUNCTION public.taiu_matches_lineup_names()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM public.refresh_match_lineup_names(
        public.match_lineup_ids(ARRAY[NEW.id])
        || CASE WHEN TG_OP = 'UPDATE' THEN ARRAY[OLD.lineup_1_id, OLD.lineup_2_id] ELSE ARRAY[]::uuid[] END
    );
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_matches_lineup_names ON public.matches;
CREATE TRIGGER tai_matches_lineup_names
    AFTER INSERT ON public.matches
    FOR EACH ROW EXECUTE FUNCTION public.taiu_matches_lineup_names();

DROP TRIGGER IF EXISTS tau_matches_lineup_names ON public.matches;
CREATE TRIGGER tau_matches_lineup_names
    AFTER UPDATE OF lineup_1_id, lineup_2_id ON public.matches
    FOR EACH ROW
    WHEN (OLD.lineup_1_id IS DISTINCT FROM NEW.lineup_1_id
       OR OLD.lineup_2_id IS DISTINCT FROM NEW.lineup_2_id)
    EXECUTE FUNCTION public.taiu_matches_lineup_names();

CREATE OR REPLACE FUNCTION public.tau_teams_lineup_names()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM public.refresh_match_lineup_names(ARRAY(
        SELECT ml.id FROM match_lineups ml WHERE ml.team_id = NEW.id
        UNION
        SELECT unnest(public.match_lineup_ids(ARRAY(
            SELECT tb.match_id
            FROM tournament_brackets tb
            JOIN tournament_teams tt
              ON tt.id IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
            WHERE tt.team_id = NEW.id AND tb.match_id IS NOT NULL
        )))
    ));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_teams_lineup_names ON public.teams;
CREATE TRIGGER tau_teams_lineup_names
    AFTER UPDATE OF name ON public.teams
    FOR EACH ROW
    WHEN (OLD.name IS DISTINCT FROM NEW.name)
    EXECUTE FUNCTION public.tau_teams_lineup_names();

CREATE OR REPLACE FUNCTION public.tau_tournament_teams_lineup_names()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM public.refresh_match_lineup_names(public.match_lineup_ids(ARRAY(
        SELECT tb.match_id
        FROM tournament_brackets tb
        WHERE NEW.id IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
          AND tb.match_id IS NOT NULL
    )));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournament_teams_lineup_names ON public.tournament_teams;
CREATE TRIGGER tau_tournament_teams_lineup_names
    AFTER UPDATE OF name, team_id ON public.tournament_teams
    FOR EACH ROW
    WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.team_id IS DISTINCT FROM NEW.team_id)
    EXECUTE FUNCTION public.tau_tournament_teams_lineup_names();

CREATE OR REPLACE FUNCTION public.taiud_tournament_brackets_lineup_names()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM public.refresh_match_lineup_names(public.match_lineup_ids(ARRAY(
        SELECT match_id FROM (
            SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.match_id END AS match_id
            UNION
            SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.match_id END
        ) ids
        WHERE match_id IS NOT NULL
    )));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_tournament_brackets_lineup_names ON public.tournament_brackets;
CREATE TRIGGER tai_tournament_brackets_lineup_names
    AFTER INSERT ON public.tournament_brackets
    FOR EACH ROW
    WHEN (NEW.match_id IS NOT NULL)
    EXECUTE FUNCTION public.taiud_tournament_brackets_lineup_names();

DROP TRIGGER IF EXISTS tau_tournament_brackets_lineup_names ON public.tournament_brackets;
CREATE TRIGGER tau_tournament_brackets_lineup_names
    AFTER UPDATE OF match_id, tournament_team_id_1, tournament_team_id_2 ON public.tournament_brackets
    FOR EACH ROW
    WHEN (OLD.match_id IS DISTINCT FROM NEW.match_id
       OR OLD.tournament_team_id_1 IS DISTINCT FROM NEW.tournament_team_id_1
       OR OLD.tournament_team_id_2 IS DISTINCT FROM NEW.tournament_team_id_2)
    EXECUTE FUNCTION public.taiud_tournament_brackets_lineup_names();

DROP TRIGGER IF EXISTS tad_tournament_brackets_lineup_names ON public.tournament_brackets;
CREATE TRIGGER tad_tournament_brackets_lineup_names
    AFTER DELETE ON public.tournament_brackets
    FOR EACH ROW
    WHEN (OLD.match_id IS NOT NULL)
    EXECUTE FUNCTION public.taiud_tournament_brackets_lineup_names();
