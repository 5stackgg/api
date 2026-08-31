-- Tournament-scoped player board. v_tournament_player_stats already aggregates
-- the same matches but carries no adr and no rating, which is the whole reason
-- this exists: those two live in player_match_map_stats / v_player_match_map_hltv.
--
-- Stale-overload cleanup: CREATE OR REPLACE cannot remove an old overload once
-- a second signature exists (SQLSTATE 42725). Drop known signatures first so
-- re-applying this file always lands on exactly one get_tournament_leaderboard.
DROP FUNCTION IF EXISTS public.get_tournament_leaderboard(UUID);
DROP FUNCTION IF EXISTS public.get_tournament_leaderboard(UUID, JSON);

-- LANGUAGE plpgsql (not sql): a "sql"-language body is parsed for relation
-- references at CREATE time, so this function would fail to create on a fresh
-- install before v_player_match_map_hltv exists in a later boot phase.
CREATE OR REPLACE FUNCTION public.get_tournament_leaderboard(
  _tournament_id UUID,
  hasura_session JSON DEFAULT NULL
)
RETURNS SETOF public.tournament_leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  -- Exposed to guest and takes an arbitrary id, so it re-applies the tournaments
  -- table's own select rule: a Setup tournament is only visible to its
  -- organizers. Hasura does not filter a function's rows for you.
  IF NOT EXISTS (
    SELECT 1 FROM public.tournaments t
    WHERE t.id = _tournament_id
      AND (
        t.status <> 'Setup'
        OR public.is_tournament_organizer(t, hasura_session)
      )
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH t_matches AS (
    SELECT DISTINCT tb.match_id
    FROM public.tournament_brackets tb
    JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE ts.tournament_id = _tournament_id
      AND tb.match_id IS NOT NULL
  ),
  agg AS (
    SELECT
        pmms.steam_id,
        SUM(pmms.kills)::int         AS kills,
        SUM(pmms.deaths)::int        AS deaths,
        SUM(pmms.assists)::int       AS assists,
        SUM(pmms.hs_kills)::int      AS hs_kills,
        SUM(pmms.damage)::float      AS damage,
        SUM(pmms.rounds_played)::int AS rounds_played,
        COUNT(DISTINCT pmms.match_id)::int AS matches_played,
        -- Round-weighted, so a one-map cameo cannot outrank a full run.
        CASE WHEN SUM(h.rounds_played) > 0
             THEN SUM(COALESCE(h.hltv_rating, 0) * h.rounds_played)
                  / SUM(h.rounds_played)
             ELSE 0
        END AS rating
    FROM t_matches tm
    JOIN public.player_match_map_stats pmms ON pmms.match_id = tm.match_id
    LEFT JOIN public.v_player_match_map_hltv h
           ON h.match_map_id = pmms.match_map_id
          AND h.steam_id = pmms.steam_id
    GROUP BY pmms.steam_id
  )
  SELECT
    a.steam_id::text,
    p.name,
    p.avatar_url,
    p.custom_avatar_url,
    p.country,
    ttr.tournament_team_id,
    tt.name,
    ROUND(a.rating::numeric, 2)::float,
    CASE WHEN a.rounds_played > 0
         THEN ROUND((a.damage / a.rounds_played)::numeric, 1)::float
         ELSE 0 END,
    a.kills,
    a.deaths,
    a.assists,
    CASE WHEN a.deaths = 0
         THEN a.kills::float
         ELSE ROUND((a.kills::numeric / a.deaths::numeric), 2)::float END,
    CASE WHEN a.kills = 0
         THEN 0::float
         ELSE ROUND((a.hs_kills::numeric / a.kills::numeric) * 100, 1)::float END,
    a.rounds_played,
    a.matches_played
  FROM agg a
  JOIN public.players p ON p.steam_id = a.steam_id
  LEFT JOIN public.tournament_team_roster ttr
         ON ttr.tournament_id = _tournament_id
        AND ttr.player_steam_id = a.steam_id
  LEFT JOIN public.tournament_teams tt ON tt.id = ttr.tournament_team_id
  -- No LIMIT: the web paginates via Hasura order_by/limit/offset, and an
  -- in-function cap would truncate the aggregate count as well as the rows.
  ORDER BY a.rating DESC;
END;
$$;
