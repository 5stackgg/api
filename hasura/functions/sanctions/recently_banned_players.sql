-- The /bans list: everyone banned recently, on Steam (VAC or game ban) or here
-- (by staff, or automatically by the vac_ban rule), one row per player.
--
-- Steam only says how many whole days ago the LATEST ban of either kind was,
-- as of when we last asked (steam_bans_checked_at), so a Steam ban is a day,
-- not a moment: steam_banned_on. Each kind keeps its own date as well
-- (players.last_vac_ban_at / last_game_ban_at), so the VAC and game filters
-- read vac_banned_on and game_banned_on. banned_at puts the day at 00:00 UTC,
-- so a 5Stack ban on the same day sorts as the newer of the two.
--
-- The viewer comes from the Hasura session. With a played-with filter on, only
-- players who shared a finished match with the viewer are listed, and
-- shared_matches holds just the matches that passed the filter. Guests get no
-- rows from a played-with filter and NULL shared_matches.
--
-- "Matches here" are 5Stack matches that were actually played (Live or ended);
-- shared matches are only the ended ones, since they carry a result.
CREATE OR REPLACE FUNCTION public.recently_banned_players(
    _window_days INT DEFAULT 30,
    _kinds TEXT[] DEFAULT ARRAY['vac', 'game', 'staff', 'auto'],
    _status TEXT DEFAULT 'any',
    _timing TEXT DEFAULT 'any',
    _played_with TEXT DEFAULT 'any',
    _lost_only BOOLEAN DEFAULT false,
    _search TEXT DEFAULT NULL,
    hasura_session JSON DEFAULT NULL
)
RETURNS SETOF public.recent_ban_entries
LANGUAGE sql
STABLE
AS $$
WITH params AS (
    SELECT
        GREATEST(1, LEAST(365, COALESCE(_window_days, 30))) AS days,
        COALESCE(_kinds, ARRAY['vac', 'game', 'staff', 'auto']) AS kinds,
        COALESCE(_status, 'any') AS status,
        COALESCE(_timing, 'any') AS timing,
        COALESCE(
            NULLIF(hasura_session ->> 'x-hasura-user-id', '')::bigint,
            public.hasura_session_steam_id()
        ) AS viewer,
        -- Losses only means losses against or alongside anyone.
        CASE
            WHEN COALESCE(_played_with, 'any') = 'any' AND COALESCE(_lost_only, false) THEN 'either'
            ELSE COALESCE(_played_with, 'any')
        END AS played_with,
        COALESCE(_lost_only, false) AS lost_only,
        NULLIF(btrim(COALESCE(_search, '')), '') AS search
),
bounds AS (
    SELECT
        p.*,
        now() - make_interval(days => p.days) AS since,
        (now() AT TIME ZONE 'UTC')::date - p.days AS since_day
    FROM params p
),
steam AS (
    SELECT
        pl.steam_id,
        latest.day AS banned_on,
        kind.vac_on,
        kind.game_on,
        -- "Before joining" and "matches since" count from the newest ban of
        -- the Steam kinds asked for.
        COALESCE(
            GREATEST(
                CASE WHEN 'vac' = ANY (b.kinds) THEN kind.vac_on END,
                CASE WHEN 'game' = ANY (b.kinds) THEN kind.game_on END
            ),
            latest.day
        ) AS kinds_on
    FROM public.players pl
    CROSS JOIN bounds b
    CROSS JOIN LATERAL (
        SELECT (pl.steam_bans_checked_at AT TIME ZONE 'UTC')::date - COALESCE(pl.days_since_last_ban, 0) AS day
    ) latest
    -- A row the api wrote before each kind had its own date falls back to the
    -- newest ban of either kind.
    CROSS JOIN LATERAL (
        SELECT
            CASE WHEN pl.vac_ban_count > 0
                THEN COALESCE((pl.last_vac_ban_at AT TIME ZONE 'UTC')::date, latest.day)
            END AS vac_on,
            CASE WHEN pl.game_ban_count > 0
                THEN COALESCE((pl.last_game_ban_at AT TIME ZONE 'UTC')::date, latest.day)
            END AS game_on
    ) kind
    WHERE (pl.vac_ban_count > 0 OR pl.game_ban_count > 0)
      AND pl.steam_bans_checked_at IS NOT NULL
),
candidates AS (
    SELECT s.steam_id
    FROM steam s
    CROSS JOIN bounds b
    WHERE ('vac' = ANY (b.kinds) AND s.vac_on >= b.since_day)
       OR ('game' = ANY (b.kinds) AND s.game_on >= b.since_day)
    UNION
    SELECT ps.player_steam_id
    FROM public.player_sanctions ps
    CROSS JOIN bounds b
    WHERE ps.type = 'ban'
      AND ps.deleted_at IS NULL
      AND ps.created_at >= b.since
      AND (CASE WHEN ps.sanctioned_by_steam_id IS NULL THEN 'auto' ELSE 'staff' END) = ANY (b.kinds)
),
details AS (
    SELECT
        pl.steam_id,
        pl.name,
        pl.vac_ban_count,
        pl.game_ban_count,
        s.banned_on AS steam_banned_on,
        s.vac_on AS vac_banned_on,
        s.game_on AS game_banned_on,
        ban.id AS sanction_id,
        ban.kind AS sanction_kind,
        public.is_banned(pl) AS banned_here,
        hist.first_match_at,
        hist.last_match_at,
        lastmap.name AS last_match_map,
        hist.matches_played,
        hist.matches_since_steam_ban,
        (s.kinds_on IS NOT NULL
            AND (hist.first_match_at IS NULL
                OR s.kinds_on < (hist.first_match_at AT TIME ZONE 'UTC')::date)) AS arrived_banned
    FROM candidates c
    JOIN public.players pl ON pl.steam_id = c.steam_id
    LEFT JOIN steam s ON s.steam_id = pl.steam_id
    LEFT JOIN LATERAL (
        SELECT
            ps.id,
            CASE WHEN ps.sanctioned_by_steam_id IS NULL THEN 'auto' ELSE 'staff' END AS kind
        FROM public.player_sanctions ps
        WHERE ps.player_steam_id = pl.steam_id
          AND ps.type = 'ban'
          AND ps.deleted_at IS NULL
        ORDER BY ps.created_at DESC
        LIMIT 1
    ) ban ON true
    LEFT JOIN LATERAL (
        SELECT
            MIN(pm.played_at) AS first_match_at,
            MAX(pm.played_at) AS last_match_at,
            COUNT(*)::int AS matches_played,
            CASE
                WHEN s.kinds_on IS NULL THEN NULL
                ELSE (COUNT(*) FILTER (WHERE (pm.played_at AT TIME ZONE 'UTC')::date >= s.kinds_on))::int
            END AS matches_since_steam_ban,
            (ARRAY_AGG(pm.match_id ORDER BY pm.played_at DESC))[1] AS last_match_id
        FROM (
            SELECT DISTINCT m.id AS match_id, COALESCE(m.started_at, m.created_at) AS played_at
            FROM public.match_lineup_players mlp
            JOIN public.matches m ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
            WHERE mlp.steam_id = pl.steam_id
              AND m.source = '5stack'
              AND m.status IN ('Live', 'Finished', 'Forfeit', 'Surrendered', 'Tie')
        ) pm
    ) hist ON true
    LEFT JOIN LATERAL (
        SELECT mp.name
        FROM public.match_maps mm
        JOIN public.maps mp ON mp.id = mm.map_id
        WHERE mm.match_id = hist.last_match_id
        ORDER BY mm."order"
        LIMIT 1
    ) lastmap ON true
),
viewer_matches AS (
    SELECT DISTINCT
        m.id AS match_id,
        me.match_lineup_id AS viewer_lineup_id,
        m.lineup_1_id,
        m.lineup_2_id,
        m.winning_lineup_id,
        m.match_options_id,
        COALESCE(m.started_at, m.created_at) AS played_at
    FROM bounds b
    JOIN public.match_lineup_players me ON me.steam_id = b.viewer
    JOIN public.matches m ON me.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE m.source = '5stack'
      AND m.status IN ('Finished', 'Forfeit', 'Surrendered', 'Tie')
),
-- One row per side of each of the viewer's matches, so a candidate's lineup
-- rows meet them on an equality join.
viewer_lineups AS (
    SELECT vm.*, l.lineup_id
    FROM viewer_matches vm
    CROSS JOIN LATERAL (VALUES (vm.lineup_1_id), (vm.lineup_2_id)) AS l (lineup_id)
),
shared AS (
    SELECT DISTINCT
        c.steam_id,
        vl.match_id,
        vl.played_at,
        vl.match_options_id,
        vl.viewer_lineup_id = vl.lineup_1_id AS viewer_is_lineup_1,
        CASE WHEN them.match_lineup_id = vl.viewer_lineup_id THEN 'teammate' ELSE 'opponent' END AS side,
        CASE WHEN vl.winning_lineup_id IS NULL THEN NULL ELSE vl.winning_lineup_id = vl.viewer_lineup_id END AS won
    FROM candidates c
    CROSS JOIN bounds b
    JOIN public.match_lineup_players them ON them.steam_id = c.steam_id
    JOIN viewer_lineups vl ON vl.lineup_id = them.match_lineup_id
    WHERE c.steam_id IS DISTINCT FROM b.viewer
),
shared_kept AS (
    SELECT sh.*
    FROM shared sh
    CROSS JOIN bounds b
    WHERE b.played_with = 'any'
       OR ((b.played_with = 'either'
            OR (b.played_with = 'opponent' AND sh.side = 'opponent')
            OR (b.played_with = 'teammate' AND sh.side = 'teammate'))
           AND (NOT b.lost_only OR sh.won = false))
),
-- Rounds for a best of 1, maps won for a series.
shared_json AS (
    SELECT
        sk.steam_id,
        jsonb_agg(
            jsonb_build_object(
                'match_id', sk.match_id,
                'played_at', sk.played_at,
                'map', sc.map,
                'viewer_score', CASE WHEN sk.viewer_is_lineup_1 THEN sc.lineup_1 ELSE sc.lineup_2 END,
                'other_score', CASE WHEN sk.viewer_is_lineup_1 THEN sc.lineup_2 ELSE sc.lineup_1 END,
                'won', sk.won,
                'side', sk.side
            )
            ORDER BY sk.played_at DESC, sk.match_id
        ) AS shared_matches
    FROM shared_kept sk
    LEFT JOIN public.match_options mo ON mo.id = sk.match_options_id
    LEFT JOIN LATERAL (
        SELECT
            first_map.name AS map,
            CASE WHEN COALESCE(mo.best_of, 1) <= 1 THEN COALESCE(first_map.lineup_1, 0) ELSE maps_won.lineup_1 END AS lineup_1,
            CASE WHEN COALESCE(mo.best_of, 1) <= 1 THEN COALESCE(first_map.lineup_2, 0) ELSE maps_won.lineup_2 END AS lineup_2
        FROM (
            SELECT
                COUNT(*) FILTER (WHERE public.lineup_1_score(mm) > public.lineup_2_score(mm))::int AS lineup_1,
                COUNT(*) FILTER (WHERE public.lineup_2_score(mm) > public.lineup_1_score(mm))::int AS lineup_2
            FROM public.match_maps mm
            WHERE mm.match_id = sk.match_id
              AND mm.status = 'Finished'
        ) maps_won
        LEFT JOIN LATERAL (
            SELECT mp.name, public.lineup_1_score(mm) AS lineup_1, public.lineup_2_score(mm) AS lineup_2
            FROM public.match_maps mm
            JOIN public.maps mp ON mp.id = mm.map_id
            WHERE mm.match_id = sk.match_id
            ORDER BY mm."order"
            LIMIT 1
        ) first_map ON true
    ) sc ON true
    GROUP BY sk.steam_id
)
SELECT
    d.steam_id,
    ev.at AS banned_at,
    ev.src AS banned_at_source,
    d.steam_banned_on,
    d.vac_ban_count,
    d.game_ban_count,
    d.sanction_id,
    d.sanction_kind,
    d.banned_here,
    d.first_match_at,
    d.last_match_at,
    d.last_match_map,
    d.matches_played,
    d.matches_since_steam_ban,
    d.arrived_banned,
    CASE WHEN b.viewer IS NULL THEN NULL ELSE COALESCE(sj.shared_matches, '[]'::jsonb) END AS shared_matches,
    d.vac_banned_on,
    d.game_banned_on
FROM details d
CROSS JOIN bounds b
CROSS JOIN LATERAL (
    -- The newest ban of a requested kind inside the window.
    SELECT e.at, e.src
    FROM (
        SELECT (st.day::timestamp AT TIME ZONE 'UTC') AS at, 'steam'::text AS src
        FROM (
            SELECT GREATEST(
                CASE WHEN 'vac' = ANY (b.kinds) AND d.vac_banned_on >= b.since_day THEN d.vac_banned_on END,
                CASE WHEN 'game' = ANY (b.kinds) AND d.game_banned_on >= b.since_day THEN d.game_banned_on END
            ) AS day
        ) st
        WHERE st.day IS NOT NULL
        UNION ALL
        SELECT ps.created_at, '5stack'::text
        FROM public.player_sanctions ps
        WHERE ps.player_steam_id = d.steam_id
          AND ps.type = 'ban'
          AND ps.deleted_at IS NULL
          AND ps.created_at >= b.since
          AND (CASE WHEN ps.sanctioned_by_steam_id IS NULL THEN 'auto' ELSE 'staff' END) = ANY (b.kinds)
    ) e
    ORDER BY e.at DESC
    LIMIT 1
) ev
LEFT JOIN shared_json sj ON sj.steam_id = d.steam_id
WHERE (b.search IS NULL
        OR position(lower(b.search) IN lower(d.name)) > 0
        OR d.steam_id::text = b.search)
  AND (b.played_with = 'any' OR sj.steam_id IS NOT NULL)
  AND (b.status = 'any'
        OR (b.status = 'banned_here' AND d.banned_here)
        OR (b.status = 'not_banned_here' AND d.steam_banned_on IS NOT NULL AND NOT d.banned_here))
  AND (b.timing = 'any'
        OR (b.timing = 'played_first' AND NOT d.arrived_banned)
        OR (b.timing = 'arrived_banned' AND d.arrived_banned))
ORDER BY ev.at DESC, d.steam_id;
$$;
