-- Seasons are gated by an admin toggle (Additional Features). When off, ELO
-- behaves as a single global ladder per type (pre-seasons behavior) and season
-- stats are not tracked; when on, ELO/stats become season-scoped.
CREATE OR REPLACE FUNCTION public.seasons_enabled() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(
        (SELECT value FROM settings WHERE name = 'public.seasons_enabled'),
        'false'
    ) = 'true';
$$;

-- The season whose [starts_at, ends_at) range contains the given timestamp.
-- ends_at IS NULL means the season is ongoing (open-ended). Non-overlap is enforced
-- by an exclusion constraint, so at most one season can match.
CREATE OR REPLACE FUNCTION public.season_for_timestamp(_ts timestamptz) RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
    SELECT id
    FROM seasons
    WHERE _ts >= starts_at
      AND (ends_at IS NULL OR _ts < ends_at)
    ORDER BY starts_at DESC
    LIMIT 1;
$$;

-- The currently active season (the one containing now()), or NULL when off-season.
CREATE OR REPLACE FUNCTION public.get_active_season() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT season_for_timestamp(now()); $$;

-- Authoritative rebuild of a season's aggregate player stats from the source
-- player_kills / player_assists rows. Used by the season backfill job so stats
-- can be recomputed deterministically (the live triggers keep it current after).
CREATE OR REPLACE FUNCTION public.rebuild_player_season_stats(_season_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM player_season_stats WHERE season_id = _season_id;

    INSERT INTO player_season_stats (
        player_steam_id, season_id, kills, deaths, assists, headshots, headshot_percentage
    )
    SELECT
        steam_id,
        _season_id,
        SUM(kills),
        SUM(deaths),
        SUM(assists),
        SUM(headshots),
        CASE WHEN SUM(kills) > 0 THEN SUM(headshots)::float / SUM(kills) ELSE 0 END
    FROM (
        SELECT pk.attacker_steam_id AS steam_id,
               COUNT(*) AS kills,
               0 AS deaths,
               0 AS assists,
               COUNT(*) FILTER (WHERE pk.headshot) AS headshots
        FROM player_kills pk
        JOIN matches m ON m.id = pk.match_id
        WHERE season_for_timestamp(m.ended_at) = _season_id
        GROUP BY pk.attacker_steam_id

        UNION ALL

        SELECT pk.attacked_steam_id, 0, COUNT(*), 0, 0
        FROM player_kills pk
        JOIN matches m ON m.id = pk.match_id
        WHERE season_for_timestamp(m.ended_at) = _season_id
        GROUP BY pk.attacked_steam_id

        UNION ALL

        SELECT pa.attacker_steam_id, 0, 0, COUNT(*), 0
        FROM player_assists pa
        JOIN matches m ON m.id = pa.match_id
        WHERE season_for_timestamp(m.ended_at) = _season_id
        GROUP BY pa.attacker_steam_id
    ) agg
    WHERE steam_id IS NOT NULL
    GROUP BY steam_id;
END;
$$;
