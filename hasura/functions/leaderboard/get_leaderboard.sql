CREATE OR REPLACE FUNCTION public.get_leaderboard(
  _category TEXT,
  _window_days INT,
  _match_type TEXT DEFAULT NULL,
  _exclude_tournaments BOOLEAN DEFAULT FALSE
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF _category = 'elo' THEN
    RETURN QUERY SELECT * FROM _leaderboard_elo(_window_days, _match_type, _exclude_tournaments);

  ELSIF _category = 'best_kdr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_kdr(_window_days, _match_type, _exclude_tournaments);

  ELSIF _category = 'best_win_rate' THEN
    RETURN QUERY SELECT * FROM _leaderboard_win_rate(_window_days, _match_type, _exclude_tournaments);

  ELSIF _category = 'highest_hs_pct' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hs_pct(_window_days, _match_type, _exclude_tournaments);

  ELSE
    RAISE EXCEPTION 'Invalid category: %. Must be one of: elo, best_kdr, best_win_rate, highest_hs_pct', _category;
  END IF;
END;
$$;

-- ============================================================
-- ELO leaderboard
-- value = current ELO, secondary = ELO change, tertiary = win streak
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_elo(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF _exclude_tournaments THEN
    RETURN QUERY
    WITH last_elo_raw AS (
      SELECT DISTINCT ON (pe.steam_id)
        pe.steam_id,
        pe.current as raw_current
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_window_days = 0 OR pe.created_at >= NOW() - make_interval(days => _window_days))
      ORDER BY pe.steam_id, pe.created_at DESC
    ),
    tournament_adj AS (
      SELECT pe.steam_id, SUM(pe.change) as tourney_total
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_window_days = 0 OR pe.created_at >= NOW() - make_interval(days => _window_days))
        AND EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
      GROUP BY pe.steam_id
    ),
    first_elo AS (
      SELECT DISTINCT ON (pe.steam_id)
        pe.steam_id,
        pe.current - pe.change as starting_elo
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_window_days = 0 OR pe.created_at >= NOW() - make_interval(days => _window_days))
      ORDER BY pe.steam_id, pe.created_at ASC
    ),
    match_counts AS (
      SELECT pe.steam_id, COUNT(*)::int as matches_played
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_window_days = 0 OR pe.created_at >= NOW() - make_interval(days => _window_days))
        AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
      GROUP BY pe.steam_id
    ),
    win_streak AS (
      SELECT sub.steam_id,
        COALESCE(MIN(CASE WHEN sub.won = 0 THEN sub.rn END) - 1, MAX(sub.rn))::int as streak
      FROM (
        SELECT
          mlp.steam_id,
          CASE WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 1 ELSE 0 END as won,
          ROW_NUMBER() OVER (PARTITION BY mlp.steam_id ORDER BY m.ended_at DESC) as rn
        FROM match_lineup_players mlp
        JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        JOIN matches m ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
        JOIN match_options mo ON mo.id = m.match_options_id
        WHERE m.status = 'Finished'
          AND mlp.steam_id IS NOT NULL
          AND m.winning_lineup_id IS NOT NULL
          AND (_window_days = 0 OR m.ended_at >= NOW() - make_interval(days => _window_days))
          AND (_match_type IS NULL OR mo.type = _match_type)
          AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id)
      ) sub
      GROUP BY sub.steam_id
    )
    SELECT
      le.steam_id::text          as player_steam_id,
      p.name                     as player_name,
      p.avatar_url               as player_avatar_url,
      p.country                  as player_country,
      (le.raw_current - COALESCE(ta.tourney_total, 0))::float as value,
      ((le.raw_current - COALESCE(ta.tourney_total, 0)) - fe.starting_elo)::float as secondary_value,
      COALESCE(ws.streak, 0)::float as tertiary_value,
      COALESCE(mc.matches_played, 0)::int as matches_played
    FROM last_elo_raw le
    LEFT JOIN tournament_adj ta ON ta.steam_id = le.steam_id
    JOIN first_elo fe ON fe.steam_id = le.steam_id
    LEFT JOIN match_counts mc ON mc.steam_id = le.steam_id
    LEFT JOIN win_streak ws ON ws.steam_id = le.steam_id
    JOIN players p ON p.steam_id = le.steam_id
    ORDER BY value DESC;

  ELSE
    RETURN QUERY
    WITH last_elo AS (
      SELECT DISTINCT ON (pe.steam_id)
        pe.steam_id,
        pe.current as current_elo
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_window_days = 0 OR pe.created_at >= NOW() - make_interval(days => _window_days))
      ORDER BY pe.steam_id, pe.created_at DESC
    ),
    first_elo AS (
      SELECT DISTINCT ON (pe.steam_id)
        pe.steam_id,
        pe.current - pe.change as starting_elo
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_window_days = 0 OR pe.created_at >= NOW() - make_interval(days => _window_days))
      ORDER BY pe.steam_id, pe.created_at ASC
    ),
    match_counts AS (
      SELECT pe.steam_id, COUNT(*)::int as matches_played
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_window_days = 0 OR pe.created_at >= NOW() - make_interval(days => _window_days))
      GROUP BY pe.steam_id
    ),
    win_streak AS (
      SELECT sub.steam_id,
        COALESCE(MIN(CASE WHEN sub.won = 0 THEN sub.rn END) - 1, MAX(sub.rn))::int as streak
      FROM (
        SELECT
          mlp.steam_id,
          CASE WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 1 ELSE 0 END as won,
          ROW_NUMBER() OVER (PARTITION BY mlp.steam_id ORDER BY m.ended_at DESC) as rn
        FROM match_lineup_players mlp
        JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        JOIN matches m ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
        JOIN match_options mo ON mo.id = m.match_options_id
        WHERE m.status = 'Finished'
          AND mlp.steam_id IS NOT NULL
          AND m.winning_lineup_id IS NOT NULL
          AND (_window_days = 0 OR m.ended_at >= NOW() - make_interval(days => _window_days))
          AND (_match_type IS NULL OR mo.type = _match_type)
      ) sub
      GROUP BY sub.steam_id
    )
    SELECT
      le.steam_id::text          as player_steam_id,
      p.name                     as player_name,
      p.avatar_url               as player_avatar_url,
      p.country                  as player_country,
      le.current_elo::float      as value,
      (le.current_elo - fe.starting_elo)::float as secondary_value,
      COALESCE(ws.streak, 0)::float as tertiary_value,
      mc.matches_played::int     as matches_played
    FROM last_elo le
    JOIN first_elo fe ON fe.steam_id = le.steam_id
    JOIN match_counts mc ON mc.steam_id = le.steam_id
    LEFT JOIN win_streak ws ON ws.steam_id = le.steam_id
    JOIN players p ON p.steam_id = le.steam_id
    ORDER BY value DESC;
  END IF;
END;
$$;

-- ============================================================
-- K/D Ratio leaderboard
-- value = K/D ratio, secondary = kills, tertiary = deaths
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_kdr(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH kills AS (
    SELECT
      pk.attacker_steam_id as steam_id,
      COUNT(*) as kill_count,
      COUNT(DISTINCT pk.match_id)::int as match_count
    FROM player_kills pk
    LEFT JOIN matches m ON (_match_type IS NOT NULL AND m.id = pk.match_id)
    LEFT JOIN match_options mo ON (_match_type IS NOT NULL AND mo.id = m.match_options_id)
    WHERE pk.attacker_steam_id IS NOT NULL
      AND pk.attacker_steam_id != pk.attacked_steam_id
      AND (_window_days = 0 OR pk.time >= NOW() - make_interval(days => _window_days))
      AND (_match_type IS NULL OR mo.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pk.match_id))
    GROUP BY pk.attacker_steam_id
  ),
  deaths AS (
    SELECT
      dk.attacked_steam_id as steam_id,
      COUNT(*) as death_count
    FROM player_kills dk
    LEFT JOIN matches m2 ON (_match_type IS NOT NULL AND m2.id = dk.match_id)
    LEFT JOIN match_options mo2 ON (_match_type IS NOT NULL AND mo2.id = m2.match_options_id)
    WHERE 1=1
      AND (_window_days = 0 OR dk.time >= NOW() - make_interval(days => _window_days))
      AND (_match_type IS NULL OR mo2.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = dk.match_id))
    GROUP BY dk.attacked_steam_id
  )
  SELECT
    k.steam_id::text           as player_steam_id,
    p.name                     as player_name,
    p.avatar_url               as player_avatar_url,
    p.country                  as player_country,
    CASE WHEN COALESCE(d.death_count, 0) = 0
      THEN k.kill_count::float
      ELSE ROUND((k.kill_count::numeric / d.death_count::numeric), 2)::float
    END                        as value,
    k.kill_count::float        as secondary_value,
    COALESCE(d.death_count, 0)::float as tertiary_value,
    k.match_count              as matches_played
  FROM kills k
  LEFT JOIN deaths d ON d.steam_id = k.steam_id
  JOIN players p ON p.steam_id = k.steam_id
  WHERE k.match_count >= 5
  ORDER BY value DESC;
END;
$$;

-- ============================================================
-- Win Rate leaderboard
-- value = win%, secondary = wins, tertiary = losses
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_win_rate(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH player_matches AS (
    SELECT
      mlp.steam_id,
      m.id as match_id,
      CASE WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 1 ELSE 0 END as won
    FROM match_lineup_players mlp
    JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
    JOIN matches m ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.status = 'Finished'
      AND mlp.steam_id IS NOT NULL
      AND m.winning_lineup_id IS NOT NULL
      AND (_window_days = 0 OR m.ended_at >= NOW() - make_interval(days => _window_days))
      AND (_match_type IS NULL OR mo.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id))
  )
  SELECT
    pm.steam_id::text          as player_steam_id,
    p.name                     as player_name,
    p.avatar_url               as player_avatar_url,
    p.country                  as player_country,
    ROUND((SUM(pm.won)::numeric / COUNT(*)::numeric) * 100, 2)::float as value,
    SUM(pm.won)::float         as secondary_value,
    (COUNT(*) - SUM(pm.won))::float as tertiary_value,
    COUNT(*)::int              as matches_played
  FROM player_matches pm
  JOIN players p ON p.steam_id = pm.steam_id
  GROUP BY pm.steam_id, p.name, p.avatar_url, p.country
  HAVING COUNT(*) >= 5
  ORDER BY value DESC;
END;
$$;

-- ============================================================
-- Headshot % leaderboard
-- value = HS%, secondary = total kills, tertiary = null
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_hs_pct(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pk.attacker_steam_id::text as player_steam_id,
    p.name                     as player_name,
    p.avatar_url               as player_avatar_url,
    p.country                  as player_country,
    ROUND((SUM(CASE WHEN pk.headshot THEN 1 ELSE 0 END)::numeric / COUNT(*)::numeric) * 100, 2)::float as value,
    COUNT(*)::float            as secondary_value,
    NULL::float                as tertiary_value,
    COUNT(DISTINCT pk.match_id)::int as matches_played
  FROM player_kills pk
  JOIN players p ON p.steam_id = pk.attacker_steam_id
  LEFT JOIN matches m ON (_match_type IS NOT NULL AND m.id = pk.match_id)
  LEFT JOIN match_options mo ON (_match_type IS NOT NULL AND mo.id = m.match_options_id)
  WHERE pk.attacker_steam_id IS NOT NULL
    AND pk.attacker_steam_id != pk.attacked_steam_id
    AND (_window_days = 0 OR pk.time >= NOW() - make_interval(days => _window_days))
    AND (_match_type IS NULL OR mo.type = _match_type)
    AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pk.match_id))
  GROUP BY pk.attacker_steam_id, p.name, p.avatar_url, p.country
  HAVING COUNT(*) >= 25
  ORDER BY value DESC;
END;
$$;
