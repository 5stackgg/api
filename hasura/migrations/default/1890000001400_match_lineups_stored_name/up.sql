-- match_lineups.name (get_team_name) worked a lineup's name out from its
-- match, team, tournament bracket and tournament team on every poll of a match
-- page, bracket or list. Each lineup keeps it here, and
-- hasura/triggers/match_lineup_names.sql refreshes it when any of those change.
ALTER TABLE public.match_lineups ADD COLUMN IF NOT EXISTS display_name text;

-- Filled from get_team_name as it stands; a fresh database has no lineups and
-- no function yet.
DO $$
BEGIN
    IF to_regprocedure('public.get_team_name(public.match_lineups)') IS NOT NULL THEN
        UPDATE public.match_lineups ml SET display_name = public.get_team_name(ml);
    END IF;
END;
$$;
