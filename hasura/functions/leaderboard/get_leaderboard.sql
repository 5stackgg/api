DROP FUNCTION IF EXISTS public._leaderboard_trophies(INT);
-- _role was added to these signatures; drop the older arities so CREATE
-- replaces rather than overloads them.
DROP FUNCTION IF EXISTS public.get_leaderboard(TEXT, INT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public._leaderboard_hltv_metric(TEXT, INT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public._leaderboard_udr(INT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.get_leaderboard(
  _category TEXT,
  _window_days INT,
  _match_type TEXT DEFAULT NULL,
  _exclude_tournaments BOOLEAN DEFAULT FALSE,
  _role TEXT DEFAULT NULL
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

  ELSIF _category = 'trophies' THEN
    RETURN QUERY SELECT * FROM _leaderboard_trophies(_window_days, _match_type);

  ELSIF _category = 'best_rating' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('rating', _window_days, _match_type, _exclude_tournaments, _role);

  ELSIF _category = 'best_adr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('adr', _window_days, _match_type, _exclude_tournaments, _role);

  ELSIF _category = 'best_kpr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('kpr', _window_days, _match_type, _exclude_tournaments, _role);

  ELSIF _category = 'best_kast' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('kast', _window_days, _match_type, _exclude_tournaments, _role);

  ELSIF _category = 'best_udr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_udr(_window_days, _match_type, _exclude_tournaments, _role);

  ELSE
    RAISE EXCEPTION 'Invalid category: %. Must be one of: elo, best_kdr, best_win_rate, highest_hs_pct, trophies, best_rating, best_adr, best_kpr, best_kast, best_udr', _category;
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
        JOIN matches m ON m.id = ml.match_id
        JOIN match_options mo ON mo.id = m.match_options_id
        WHERE m.status = 'Finished'
          AND m.source = '5stack'
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
        JOIN matches m ON m.id = ml.match_id
        JOIN match_options mo ON mo.id = m.match_options_id
        WHERE m.status = 'Finished'
          AND m.source = '5stack'
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
    JOIN matches m ON m.id = pk.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE pk.attacker_steam_id IS NOT NULL
      AND pk.attacker_steam_id != pk.attacked_steam_id
      AND m.source = '5stack'
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
    JOIN matches m2 ON m2.id = dk.match_id
    JOIN match_options mo2 ON mo2.id = m2.match_options_id
    WHERE 1=1
      AND m2.source = '5stack'
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
    JOIN matches m ON m.id = ml.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.status = 'Finished'
      AND m.source = '5stack'
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
  JOIN matches m ON m.id = pk.match_id
  JOIN match_options mo ON mo.id = m.match_options_id
  WHERE pk.attacker_steam_id IS NOT NULL
    AND pk.attacker_steam_id != pk.attacked_steam_id
    AND m.source = '5stack'
    AND (_window_days = 0 OR pk.time >= NOW() - make_interval(days => _window_days))
    AND (_match_type IS NULL OR mo.type = _match_type)
    AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pk.match_id))
  GROUP BY pk.attacker_steam_id, p.name, p.avatar_url, p.country
  ORDER BY value DESC;
END;
$$;

-- ============================================================
-- Trophies leaderboard
-- value = gold count, secondary = silver count, tertiary = bronze count
-- matches_played = total trophies. Olympic medal-table ordering.
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_trophies(
  _window_days INT,
  _match_type TEXT DEFAULT NULL
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH counts AS (
    SELECT
      tt.player_steam_id,
      SUM(CASE WHEN tt.placement = 0 THEN 1 ELSE 0 END)::int as mvp,
      SUM(CASE WHEN tt.placement = 1 THEN 1 ELSE 0 END)::int as gold,
      SUM(CASE WHEN tt.placement = 2 THEN 1 ELSE 0 END)::int as silver,
      SUM(CASE WHEN tt.placement = 3 THEN 1 ELSE 0 END)::int as bronze,
      COUNT(*)::int as total
    FROM tournament_trophies tt
    JOIN tournaments t ON t.id = tt.tournament_id
    JOIN match_options mo ON mo.id = t.match_options_id
    WHERE tt.player_steam_id IS NOT NULL
      AND (_window_days = 0 OR t.start >= NOW() - make_interval(days => _window_days))
      AND (_match_type IS NULL OR mo.type = _match_type)
    GROUP BY tt.player_steam_id
  )
  SELECT
    c.player_steam_id::text   as player_steam_id,
    p.name                    as player_name,
    p.avatar_url              as player_avatar_url,
    p.country                 as player_country,
    c.gold::float             as value,
    c.silver::float           as secondary_value,
    c.bronze::float           as tertiary_value,
    c.mvp                     as matches_played
  FROM counts c
  JOIN players p ON p.steam_id = c.player_steam_id
  WHERE c.total > 0
  ORDER BY c.mvp DESC, c.gold DESC, c.silver DESC, c.bronze DESC;
END;
$$;

CREATE TABLE IF NOT EXISTS public.player_leaderboard_rank (
  player_steam_id TEXT NOT NULL,
  value FLOAT NOT NULL DEFAULT 0,
  rank INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.get_player_leaderboard_rank(
  _category TEXT,
  _window_days INT,
  _player_steam_id TEXT,
  _match_type TEXT DEFAULT NULL,
  _exclude_tournaments BOOLEAN DEFAULT FALSE
)
RETURNS SETOF public.player_leaderboard_rank
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH ranked AS (
    SELECT
      le.player_steam_id,
      le.value,
      (RANK() OVER (ORDER BY le.value DESC))::int AS rank,
      (COUNT(*) OVER ())::int AS total
    FROM public.get_leaderboard(_category, _window_days, _match_type, _exclude_tournaments) le
  )
  SELECT r.player_steam_id, r.value, r.rank, r.total
  FROM ranked r
  WHERE r.player_steam_id = _player_steam_id
  LIMIT 1;
END;
$$;

-- ============================================================
-- HLTV-stat leaderboards (rating / ADR / KPR / KAST)
-- Aggregates the canonical per-map view, rounds-weighted. _metric selects
-- which stat is the headline value; secondary carries a complementary stat.
-- value/secondary semantics:
--   rating → value=HLTV rating, secondary=ADR
--   adr    → value=ADR,         secondary=HLTV rating
--   kpr    → value=KPR,         secondary=DPR
--   kast   → value=KAST%,       secondary=HLTV rating
-- tertiary = rounds played (the sample size).
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_hltv_metric(
  _metric TEXT,
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _role TEXT DEFAULT NULL
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH agg AS (
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
    JOIN matches m ON m.id = h.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    LEFT JOIN v_player_match_map_roles r
      ON _role IS NOT NULL
     AND r.match_map_id = h.match_map_id
     AND r.steam_id = h.steam_id
    WHERE m.source = '5stack'
      AND (_window_days = 0 OR m.created_at >= NOW() - make_interval(days => _window_days))
      AND (_match_type IS NULL OR mo.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = h.match_id))
      AND (_role IS NULL OR r.role = _role)
    GROUP BY h.steam_id
    HAVING SUM(h.rounds_played) >= 50
  )
  SELECT
    a.steam_id::text   AS player_steam_id,
    p.name             AS player_name,
    p.avatar_url       AS player_avatar_url,
    p.country          AS player_country,
    (CASE _metric
      WHEN 'rating' THEN ROUND(a.rating::numeric, 2)
      WHEN 'adr'    THEN ROUND(a.adr::numeric, 1)
      WHEN 'kpr'    THEN ROUND(a.kpr::numeric, 2)
      WHEN 'kast'   THEN ROUND(a.kast::numeric, 1)
    END)::float        AS value,
    (CASE _metric
      WHEN 'rating' THEN ROUND(a.adr::numeric, 1)
      WHEN 'adr'    THEN ROUND(a.rating::numeric, 2)
      WHEN 'kpr'    THEN ROUND(a.dpr::numeric, 2)
      WHEN 'kast'   THEN ROUND(a.rating::numeric, 2)
    END)::float        AS secondary_value,
    a.rounds::float    AS tertiary_value,
    a.match_count      AS matches_played
  FROM agg a
  JOIN players p ON p.steam_id = a.steam_id
  ORDER BY value DESC NULLS LAST;
END;
$$;

-- ============================================================
-- Utility-damage-per-round leaderboard
-- value = UDR, secondary = total utility damage, tertiary = rounds played
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_udr(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _role TEXT DEFAULT NULL
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH agg AS (
    SELECT
      s.steam_id,
      SUM(s.he_damage + s.molotov_damage)                                   AS util_damage,
      SUM(s.he_damage + s.molotov_damage)::numeric / NULLIF(SUM(s.rounds_played), 0) AS udr,
      SUM(s.rounds_played)                                                  AS rounds,
      COUNT(DISTINCT s.match_id)::int                                       AS match_count
    FROM player_match_map_stats s
    JOIN matches m ON m.id = s.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    LEFT JOIN v_player_match_map_roles r
      ON _role IS NOT NULL
     AND r.match_map_id = s.match_map_id
     AND r.steam_id = s.steam_id
    WHERE m.source = '5stack'
      AND (_window_days = 0 OR m.created_at >= NOW() - make_interval(days => _window_days))
      AND (_match_type IS NULL OR mo.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = s.match_id))
      AND (_role IS NULL OR r.role = _role)
    GROUP BY s.steam_id
    HAVING SUM(s.rounds_played) >= 50
  )
  SELECT
    a.steam_id::text          AS player_steam_id,
    p.name                    AS player_name,
    p.avatar_url              AS player_avatar_url,
    p.country                 AS player_country,
    ROUND(a.udr, 1)::float    AS value,
    a.util_damage::float      AS secondary_value,
    a.rounds::float           AS tertiary_value,
    a.match_count             AS matches_played
  FROM agg a
  JOIN players p ON p.steam_id = a.steam_id
  ORDER BY value DESC NULLS LAST;
END;
$$;
