CREATE OR REPLACE VIEW public.v_tournament_player_stats AS
WITH t_matches AS (
    SELECT DISTINCT
        ts.tournament_id,
        tb.match_id
    FROM tournament_brackets tb
    JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE tb.match_id IS NOT NULL
),
-- Kills, deaths and headshots come from the same player_kills rows. Unpivot
-- each kill into one row per side via LATERAL VALUES so player_kills is
-- scanned (and the chunk indexes hit) once instead of twice, then aggregate
-- both sides together keyed by player.
kd_agg AS (
    SELECT
        tm.tournament_id,
        e.steam_id,
        SUM(e.kill_flag)::int AS kills,
        SUM(e.death_flag)::int AS deaths,
        SUM(e.headshot_flag)::int AS headshots
    FROM t_matches tm
    JOIN player_kills pk
      ON pk.match_id = tm.match_id
     AND pk.attacker_steam_id IS NOT NULL
     AND pk.attacker_steam_id != pk.attacked_steam_id
    CROSS JOIN LATERAL (VALUES
        (pk.attacker_steam_id, 1, 0, CASE WHEN pk.headshot THEN 1 ELSE 0 END),
        (pk.attacked_steam_id, 0, 1, 0)
    ) AS e(steam_id, kill_flag, death_flag, headshot_flag)
    WHERE e.steam_id IS NOT NULL
    GROUP BY tm.tournament_id, e.steam_id
),
assists_agg AS (
    SELECT
        tm.tournament_id,
        pa.attacker_steam_id AS steam_id,
        COUNT(*)::int AS assists
    FROM t_matches tm
    JOIN player_assists pa ON pa.match_id = tm.match_id
    WHERE pa.attacker_steam_id IS NOT NULL
    GROUP BY tm.tournament_id, pa.attacker_steam_id
),
matches_agg AS (
    SELECT
        tm.tournament_id,
        mlp.steam_id,
        COUNT(DISTINCT tm.match_id)::int AS matches_played
    FROM t_matches tm
    JOIN matches m ON m.id = tm.match_id
    JOIN match_lineup_players mlp
      ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE mlp.steam_id IS NOT NULL
    GROUP BY tm.tournament_id, mlp.steam_id
)
SELECT
    m.tournament_id,
    m.steam_id AS player_steam_id,
    COALESCE(kd.kills, 0) AS kills,
    COALESCE(kd.headshots, 0) AS headshots,
    COALESCE(kd.deaths, 0) AS deaths,
    COALESCE(a.assists, 0) AS assists,
    m.matches_played,
    CASE WHEN COALESCE(kd.deaths, 0) = 0
         THEN COALESCE(kd.kills, 0)::float
         ELSE ROUND(COALESCE(kd.kills, 0)::numeric / kd.deaths::numeric, 2)::float
    END AS kdr,
    CASE WHEN COALESCE(kd.kills, 0) = 0
         THEN 0::float
         ELSE ROUND(COALESCE(kd.headshots, 0)::numeric / kd.kills::numeric * 100, 1)::float
    END AS headshot_percentage
FROM matches_agg m
LEFT JOIN kd_agg kd
  ON kd.tournament_id = m.tournament_id AND kd.steam_id = m.steam_id
LEFT JOIN assists_agg a
  ON a.tournament_id = m.tournament_id AND a.steam_id = m.steam_id;

-- Per-player league season stats: the per-tournament player stats above scoped
-- to the season's division tournaments, with team attribution from the league
-- roster (dual-rostering within a season is blocked by trigger, so a player maps
-- to at most one team per season).
--
-- Defined here, alongside the view it selects from, because HasuraService.apply()
-- executes hasura/views in plain alphabetical order.
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
