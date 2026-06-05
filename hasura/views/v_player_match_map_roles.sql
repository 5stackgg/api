DROP VIEW IF EXISTS public.v_player_match_map_roles;
CREATE VIEW public.v_player_match_map_roles AS
WITH kills_agg AS (
    SELECT
        pk.match_map_id,
        pk.attacker_steam_id AS steam_id,
        COUNT(*)::int AS total_kills,
        COUNT(*) FILTER (
            WHERE lower(pk."with") LIKE '%awp%' OR lower(pk."with") LIKE '%ssg%'
        )::int AS awp_kills
    FROM player_kills pk
    WHERE pk.attacker_steam_id IS NOT NULL
      AND pk.attacker_steam_id <> pk.attacked_steam_id
    GROUP BY pk.match_map_id, pk.attacker_steam_id
),
first_kills AS (
    SELECT DISTINCT ON (pk.match_map_id, pk.round)
        pk.match_map_id,
        pk.attacker_steam_id,
        pk.attacked_steam_id
    FROM player_kills pk
    WHERE pk.attacker_steam_id <> pk.attacked_steam_id
    ORDER BY pk.match_map_id, pk.round, pk."time" ASC
),
opening AS (
    SELECT
        match_map_id,
        steam_id,
        COUNT(*)::int AS opening_attempts,
        COUNT(*) FILTER (WHERE is_kill)::int AS open_kills,
        COUNT(*) FILTER (WHERE NOT is_kill)::int AS open_deaths
    FROM (
        SELECT match_map_id, attacker_steam_id AS steam_id, true AS is_kill FROM first_kills
        UNION ALL
        SELECT match_map_id, attacked_steam_id AS steam_id, false AS is_kill FROM first_kills
    ) o
    WHERE steam_id IS NOT NULL
    GROUP BY match_map_id, steam_id
),
base AS (
    SELECT
        s.match_id,
        s.match_map_id,
        s.steam_id,
        lu.lineup_id,
        s.rounds_played AS rounds,
        s.kills,
        s.deaths,
        s.trade_kill_successes,
        s.traded_death_successes,
        s.flash_assists,
        (s.he_damage + s.molotov_damage) AS util_damage,
        COALESCE(k.total_kills, 0) AS total_kills,
        COALESCE(k.awp_kills, 0) AS awp_kills,
        COALESCE(o.opening_attempts, 0) AS opening_attempts,
        COALESCE(o.open_kills, 0) AS open_kills,
        COALESCE(o.open_deaths, 0) AS open_deaths,
        h.hltv_rating,
        h.adr,
        h.kpr,
        h.dpr,
        h.kast_pct,
        CASE WHEN COALESCE(k.total_kills, 0) > 0
            THEN COALESCE(k.awp_kills, 0)::numeric / k.total_kills
            ELSE 0 END AS awp_share,
        COALESCE(o.opening_attempts, 0)::numeric / NULLIF(s.rounds_played, 0) AS entry_rate,
        (s.flash_assists + (s.he_damage + s.molotov_damage) / 100.0 + s.flashes_thrown * 0.3)
            / NULLIF(s.rounds_played, 0) AS support_idx
    FROM player_match_map_stats s
    LEFT JOIN kills_agg k ON k.match_map_id = s.match_map_id AND k.steam_id = s.steam_id
    LEFT JOIN opening o ON o.match_map_id = s.match_map_id AND o.steam_id = s.steam_id
    LEFT JOIN v_player_match_map_hltv h ON h.match_map_id = s.match_map_id AND h.steam_id = s.steam_id
    LEFT JOIN LATERAL (
        SELECT ml.id AS lineup_id
        FROM match_lineup_players mlp
        JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE mlp.steam_id = s.steam_id AND ml.match_id = s.match_id
        LIMIT 1
    ) lu ON TRUE
    WHERE s.rounds_played > 0
),
ranked AS (
    SELECT
        b.*,
        ROW_NUMBER() OVER (
            PARTITION BY b.match_map_id, b.lineup_id
            ORDER BY b.awp_kills DESC, b.awp_share DESC, b.steam_id
        ) AS awp_rk
    FROM base b
),
flag_awp AS (
    SELECT *, (awp_rk = 1 AND awp_kills >= 5 AND awp_share >= 0.20) AS is_awper
    FROM ranked
),
rank_entry AS (
    SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY match_map_id, lineup_id
            ORDER BY (CASE WHEN is_awper THEN -1 ELSE entry_rate END) DESC, steam_id
        ) AS entry_rk
    FROM flag_awp
),
flag_entry AS (
    SELECT *, (NOT is_awper AND entry_rk = 1 AND opening_attempts > 0) AS is_entry
    FROM rank_entry
),
rank_support AS (
    SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY match_map_id, lineup_id
            ORDER BY (CASE WHEN is_awper OR is_entry THEN -1 ELSE support_idx END) DESC, steam_id
        ) AS support_rk
    FROM flag_entry
),
flag_support AS (
    SELECT *, (NOT is_awper AND NOT is_entry AND support_rk = 1 AND support_idx > 0) AS is_support
    FROM rank_support
)
SELECT
    match_id,
    match_map_id,
    steam_id,
    lineup_id,
    rounds,
    kills,
    deaths,
    awp_kills,
    total_kills,
    opening_attempts,
    open_kills,
    open_deaths,
    trade_kill_successes,
    traded_death_successes,
    flash_assists,
    util_damage,
    hltv_rating,
    adr,
    kpr,
    dpr,
    kast_pct,
    ROUND(awp_share, 4) AS awp_share,
    ROUND(COALESCE(entry_rate, 0), 4) AS entry_rate,
    ROUND(COALESCE(support_idx, 0), 4) AS support_idx,
    CASE
        WHEN is_awper THEN 'Sniper'
        WHEN is_entry THEN 'Entry'
        WHEN is_support THEN 'Support'
        ELSE 'Rifler'
    END AS role
FROM flag_support;
