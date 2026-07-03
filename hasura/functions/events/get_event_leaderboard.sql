-- Event-scoped leaderboard over the event's derived match set.
-- Stale-overload cleanup: CREATE OR REPLACE cannot remove an old overload once
-- a second signature exists (SQLSTATE 42725). Drop known signatures first so
-- re-applying this file always lands on exactly one get_event_leaderboard.
DROP FUNCTION IF EXISTS public.get_event_leaderboard(UUID, TEXT, TEXT, INT);

-- LANGUAGE plpgsql (not sql): a "sql"-language body is parsed for relation
-- references at CREATE time, so this function would fail to create on a
-- fresh install before v_player_match_map_hltv exists in a later boot phase.
-- plpgsql bodies are not parsed for relation references at creation time, so
-- this creates cleanly regardless of what else has been applied yet.
CREATE OR REPLACE FUNCTION public.get_event_leaderboard(
  _event_id UUID,
  _category TEXT,
  _match_type TEXT DEFAULT NULL,
  _min_rounds INT DEFAULT 10
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF _category NOT IN ('rating', 'adr', 'kdr', 'kills', 'wins') THEN
    RAISE EXCEPTION 'get_event_leaderboard: unknown category %', _category;
  END IF;

  -- An explicit NULL would make the HAVING comparison below silently filter
  -- every row; treat it as "no minimum" instead of returning an empty board.
  IF _min_rounds IS NULL THEN
    _min_rounds := 0;
  END IF;

  -- Setup events are hidden from the public (see the events table select
  -- permissions and the e_event_status enum). This function is exposed to the
  -- guest role and takes an arbitrary event id, so guard it here: return an
  -- empty leaderboard for a Setup or unknown event rather than computing and
  -- leaking standings for an event that has not been made public yet.
  IF NOT EXISTS (
    SELECT 1 FROM public.events WHERE id = _event_id AND status <> 'Setup'
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH e_matches AS (
    SELECT DISTINCT tb.match_id
    FROM event_tournaments et
    JOIN tournament_stages ts ON ts.tournament_id = et.tournament_id
    JOIN tournament_brackets tb ON tb.tournament_stage_id = ts.id
    WHERE et.event_id = _event_id
      AND tb.match_id IS NOT NULL
),
f_matches AS (
    SELECT em.match_id
    FROM e_matches em
    JOIN matches m ON m.id = em.match_id
    LEFT JOIN match_options mo ON mo.id = m.match_options_id
    WHERE _match_type IS NULL OR mo.type = _match_type
),
roster AS (
    -- Explicit curation: when event_players has rows for this event,
    -- only those players appear on the board.
    SELECT ep.steam_id FROM event_players ep WHERE ep.event_id = _event_id
),
agg AS (
    SELECT
        pmms.steam_id,
        SUM(pmms.kills)::float   AS kills,
        SUM(pmms.deaths)::float  AS deaths,
        SUM(pmms.damage)::float  AS damage,
        SUM(pmms.rounds_played)::int AS rounds_played,
        COUNT(DISTINCT pmms.match_id)::int AS matches_played,
        CASE WHEN SUM(h.rounds_played) > 0
             THEN SUM(COALESCE(h.hltv_rating, 0) * h.rounds_played)
                  / SUM(h.rounds_played)
             ELSE 0
        END AS rating
    FROM f_matches fm
    JOIN player_match_map_stats pmms ON pmms.match_id = fm.match_id
    LEFT JOIN v_player_match_map_hltv h
           ON h.match_map_id = pmms.match_map_id
          AND h.steam_id = pmms.steam_id
    WHERE NOT EXISTS (SELECT 1 FROM roster)
       OR pmms.steam_id IN (SELECT steam_id FROM roster)
    GROUP BY pmms.steam_id
    HAVING SUM(pmms.rounds_played) >= _min_rounds
),
wins AS (
    SELECT mlp.steam_id, COUNT(DISTINCT m.id)::float AS wins
    FROM f_matches fm
    JOIN matches m ON m.id = fm.match_id AND m.winning_lineup_id IS NOT NULL
    JOIN match_lineup_players mlp ON mlp.match_lineup_id = m.winning_lineup_id
    GROUP BY mlp.steam_id
)
SELECT
    a.steam_id::text AS player_steam_id,
    p.name           AS player_name,
    p.avatar_url     AS player_avatar_url,
    p.country        AS player_country,
    CASE _category
        WHEN 'rating' THEN ROUND(a.rating::numeric, 2)::float
        WHEN 'adr'    THEN CASE WHEN a.rounds_played > 0
                                THEN ROUND((a.damage / a.rounds_played)::numeric, 1)::float
                                ELSE 0 END
        WHEN 'kdr'    THEN CASE WHEN a.deaths = 0 THEN a.kills
                                ELSE ROUND((a.kills / a.deaths)::numeric, 2)::float END
        WHEN 'kills'  THEN a.kills
        WHEN 'wins'   THEN COALESCE(w.wins, 0)
        ELSE 0
    END AS value,
    a.kills  AS secondary_value,
    a.deaths AS tertiary_value,
    a.matches_played
FROM agg a
JOIN players p ON p.steam_id = a.steam_id
LEFT JOIN wins w ON w.steam_id = a.steam_id
-- No LIMIT here: the web paginates via Hasura-level order_by/limit/offset
-- (like the global get_leaderboard), so an in-function cap would truncate
-- events with more than N participants and skew the aggregate count.
ORDER BY value DESC;
END;
$$;
