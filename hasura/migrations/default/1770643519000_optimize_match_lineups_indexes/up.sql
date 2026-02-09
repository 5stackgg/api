CREATE INDEX IF NOT EXISTS idx_match_lineups_id_team_coach
ON public.match_lineups (id)
INCLUDE (team_id, coach_steam_id);

CREATE INDEX IF NOT EXISTS idx_match_lineups_coach_steam_id
ON public.match_lineups (coach_steam_id)
WHERE coach_steam_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_match_lineups_team_id
ON public.match_lineups (team_id)
WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tournament_brackets_match_id
ON public.tournament_brackets (match_id)
INCLUDE (tournament_stage_id);

CREATE INDEX IF NOT EXISTS idx_tournament_brackets_stage_id
ON public.tournament_brackets (tournament_stage_id);