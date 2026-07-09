-- League-season player leaderboard. Isolated from get_leaderboard (the global
-- leaderboard) on purpose: it reuses the same per-map HLTV / util math but
-- scopes strictly to the matches played inside a league season's division
-- tournaments, so nothing here can affect the sitewide leaderboard.
--
-- Dropped first because CREATE OR REPLACE cannot remove an overload.
DROP FUNCTION IF EXISTS public.get_league_season_leaderboard(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_league_season_leaderboard(
  _league_season_id UUID,
  _category TEXT,
  _role TEXT DEFAULT NULL
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  -- rating / adr / kpr / kast come from the per-map HLTV view.
  IF _category IN ('best_rating', 'best_adr', 'best_kpr', 'best_kast') THEN
    RETURN QUERY
    WITH league_matches AS (
      SELECT DISTINCT tb.match_id
      FROM tournament_brackets tb
      JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
      JOIN league_season_divisions lsd ON lsd.tournament_id = ts.tournament_id
      WHERE lsd.league_season_id = _league_season_id
        AND tb.match_id IS NOT NULL
    ),
    agg AS (
      SELECT
        h.steam_id,
        SUM(h.hltv_rating * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0) AS rating,
        SUM(h.adr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0)         AS adr,
        SUM(h.kpr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0)         AS kpr,
        SUM(h.dpr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0)         AS dpr,
        SUM(h.kast_pct * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0)    AS kast,
        SUM(h.rounds_played)                                                   AS rounds,
        COUNT(DISTINCT h.match_id)::int                                        AS match_count
      FROM v_player_match_map_hltv h
      JOIN league_matches lm ON lm.match_id = h.match_id
      LEFT JOIN v_player_match_map_roles r
        ON _role IS NOT NULL
       AND r.match_map_id = h.match_map_id
       AND r.steam_id = h.steam_id
      WHERE (_role IS NULL OR r.role = _role)
      GROUP BY h.steam_id
      HAVING SUM(h.rounds_played) >= 1
    )
    SELECT
      a.steam_id::text   AS player_steam_id,
      p.name             AS player_name,
      p.avatar_url       AS player_avatar_url,
      p.country          AS player_country,
      (CASE _category
        WHEN 'best_rating' THEN ROUND(a.rating::numeric, 2)
        WHEN 'best_adr'    THEN ROUND(a.adr::numeric, 1)
        WHEN 'best_kpr'    THEN ROUND(a.kpr::numeric, 2)
        WHEN 'best_kast'   THEN ROUND(a.kast::numeric, 1)
      END)::float        AS value,
      (CASE _category
        WHEN 'best_rating' THEN ROUND(a.adr::numeric, 1)
        WHEN 'best_adr'    THEN ROUND(a.rating::numeric, 2)
        WHEN 'best_kpr'    THEN ROUND(a.dpr::numeric, 2)
        WHEN 'best_kast'   THEN ROUND(a.rating::numeric, 2)
      END)::float        AS secondary_value,
      a.rounds::float    AS tertiary_value,
      a.match_count      AS matches_played
    FROM agg a
    JOIN players p ON p.steam_id = a.steam_id
    ORDER BY value DESC NULLS LAST;

  -- utility damage per round comes from raw per-map stats.
  ELSIF _category = 'best_udr' THEN
    RETURN QUERY
    WITH league_matches AS (
      SELECT DISTINCT tb.match_id
      FROM tournament_brackets tb
      JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
      JOIN league_season_divisions lsd ON lsd.tournament_id = ts.tournament_id
      WHERE lsd.league_season_id = _league_season_id
        AND tb.match_id IS NOT NULL
    ),
    agg AS (
      SELECT
        s.steam_id,
        SUM(s.he_damage + s.molotov_damage)                                            AS util_damage,
        SUM(s.he_damage + s.molotov_damage)::numeric / NULLIF(SUM(s.rounds_played), 0) AS udr,
        SUM(s.rounds_played)                                                           AS rounds,
        COUNT(DISTINCT s.match_id)::int                                                AS match_count
      FROM player_match_map_stats s
      JOIN league_matches lm ON lm.match_id = s.match_id
      LEFT JOIN v_player_match_map_roles r
        ON _role IS NOT NULL
       AND r.match_map_id = s.match_map_id
       AND r.steam_id = s.steam_id
      WHERE (_role IS NULL OR r.role = _role)
      GROUP BY s.steam_id
      HAVING SUM(s.rounds_played) >= 1
    )
    SELECT
      a.steam_id::text        AS player_steam_id,
      p.name                  AS player_name,
      p.avatar_url            AS player_avatar_url,
      p.country               AS player_country,
      ROUND(a.udr, 1)::float  AS value,
      a.util_damage::float    AS secondary_value,
      a.rounds::float         AS tertiary_value,
      a.match_count           AS matches_played
    FROM agg a
    JOIN players p ON p.steam_id = a.steam_id
    ORDER BY value DESC NULLS LAST;

  ELSE
    RAISE EXCEPTION 'Invalid league leaderboard category: %. Must be one of: best_rating, best_adr, best_kpr, best_kast, best_udr', _category;
  END IF;
END;
$$;
