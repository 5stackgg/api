-- Postgres never indexes the referencing side of a foreign key. Deleting a
-- match (or the match_maps a veto reset drops) looks up every child row by
-- these columns, so without an index each lookup reads the whole child table.
CREATE INDEX IF NOT EXISTS player_flashes_match_id_idx
    ON public.player_flashes (match_id);
CREATE INDEX IF NOT EXISTS player_objectives_match_id_idx
    ON public.player_objectives (match_id);
CREATE INDEX IF NOT EXISTS player_utility_match_id_idx
    ON public.player_utility (match_id);
CREATE INDEX IF NOT EXISTS player_unused_utility_match_id_idx
    ON public.player_unused_utility (match_id);
CREATE INDEX IF NOT EXISTS player_aim_stats_demo_match_id_idx
    ON public.player_aim_stats_demo (match_id);
CREATE INDEX IF NOT EXISTS player_round_inventory_match_id_idx
    ON public.player_round_inventory (match_id);
CREATE INDEX IF NOT EXISTS player_match_map_event_aggregates_match_id_idx
    ON public.player_match_map_event_aggregates (match_id);
CREATE INDEX IF NOT EXISTS player_premier_rank_history_match_id_idx
    ON public.player_premier_rank_history (match_id);
CREATE INDEX IF NOT EXISTS player_faceit_rank_history_match_id_idx
    ON public.player_faceit_rank_history (match_id);
CREATE INDEX IF NOT EXISTS player_trades_match_id_idx
    ON public.player_trades (match_id);
CREATE INDEX IF NOT EXISTS abandoned_matches_match_id_idx
    ON public.abandoned_matches (match_id);
CREATE INDEX IF NOT EXISTS team_scrim_requests_match_id_idx
    ON public.team_scrim_requests (match_id);
CREATE INDEX IF NOT EXISTS utility_lineups_source_match_id_idx
    ON public.utility_lineups (source_match_id);
CREATE INDEX IF NOT EXISTS utility_demo_throws_match_id_idx
    ON public.utility_demo_throws (match_id);

CREATE INDEX IF NOT EXISTS player_damages_match_map_id_idx
    ON public.player_damages (match_map_id);
CREATE INDEX IF NOT EXISTS player_match_map_stats_match_map_id_idx
    ON public.player_match_map_stats (match_map_id);
CREATE INDEX IF NOT EXISTS utility_lineups_source_match_map_id_idx
    ON public.utility_lineups (source_match_map_id);
CREATE INDEX IF NOT EXISTS utility_demo_throws_match_map_id_idx
    ON public.utility_demo_throws (match_map_id);

CREATE INDEX IF NOT EXISTS tournament_brackets_match_options_id_idx
    ON public.tournament_brackets (match_options_id);
CREATE INDEX IF NOT EXISTS tournament_stages_match_options_id_idx
    ON public.tournament_stages (match_options_id);
CREATE INDEX IF NOT EXISTS league_seasons_match_options_id_idx
    ON public.league_seasons (match_options_id);
CREATE INDEX IF NOT EXISTS team_scrim_requests_match_options_id_idx
    ON public.team_scrim_requests (match_options_id);

CREATE INDEX IF NOT EXISTS match_region_veto_picks_match_lineup_id_idx
    ON public.match_region_veto_picks (match_lineup_id);
CREATE INDEX IF NOT EXISTS clip_render_jobs_clip_id_idx
    ON public.clip_render_jobs (clip_id);
