-- Per-player league season stats: the existing per-tournament player stats
-- scoped to the season's division tournaments, with team attribution from the
-- league roster (dual-rostering within a season is blocked by trigger, so a
-- player maps to at most one team per season).
CREATE OR REPLACE VIEW public.v_league_season_player_stats AS
SELECT
    lsd.league_season_id,
    lsd.league_division_id,
    lsd.id AS league_season_division_id,
    team.league_team_season_id,
    team.league_team_id,
    tps.player_steam_id,
    tps.kills,
    tps.deaths,
    tps.assists,
    tps.headshots,
    tps.matches_played,
    tps.kdr,
    tps.headshot_percentage
FROM public.league_season_divisions lsd
JOIN public.v_tournament_player_stats tps
  ON tps.tournament_id = lsd.tournament_id
LEFT JOIN LATERAL (
    SELECT lts.id AS league_team_season_id, lts.league_team_id
    FROM public.league_team_rosters ltr
    JOIN public.league_team_seasons lts ON lts.id = ltr.league_team_season_id
    WHERE ltr.player_steam_id = tps.player_steam_id
      AND lts.league_season_id = lsd.league_season_id
    LIMIT 1
) team ON true;
