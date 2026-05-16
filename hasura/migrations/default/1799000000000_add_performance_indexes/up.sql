create index if not exists "match_clips_match_map_id_visibility_idx"
  on "public"."match_clips" ("match_map_id", "visibility");

CREATE INDEX IF NOT EXISTS idx_tournament_team_roster_tournament_team_id
  ON public.tournament_team_roster (tournament_team_id);

CREATE INDEX IF NOT EXISTS idx_match_streams_match_id
  ON public.match_streams (match_id);

CREATE INDEX IF NOT EXISTS idx_tournament_trophies_player_steam_id
  ON public.tournament_trophies (player_steam_id)
  WHERE player_steam_id IS NOT NULL;
