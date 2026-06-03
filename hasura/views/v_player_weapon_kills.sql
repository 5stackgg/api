-- Per-player weapon kill counts split by match source and type. `type` is the
-- trailing column so CREATE OR REPLACE can evolve it without a drop.
CREATE OR REPLACE VIEW public.v_player_weapon_kills AS
SELECT
    pk.attacker_steam_id AS player_steam_id,
    m.source             AS source,
    pk."with"            AS "with",
    COUNT(*)             AS kill_count,
    mo.type              AS type,
    -- Rounds in which the player got at least one kill with this weapon.
    -- We can't know rounds a weapon was merely *held* without a kill, so
    -- this is a "rounds played (with a kill)" proxy — labeled as such in UI.
    COUNT(DISTINCT (pk.match_map_id, pk.round))::bigint AS rounds
FROM player_kills pk
    INNER JOIN matches m ON m.id = pk.match_id
    LEFT JOIN match_options mo ON mo.id = m.match_options_id
WHERE pk.attacker_steam_id IS NOT NULL
  AND pk."with" IS NOT NULL
GROUP BY pk.attacker_steam_id, m.source, pk."with", mo.type;
