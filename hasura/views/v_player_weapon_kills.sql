-- Per-player weapon kill counts split by match source and type. `type` is the
-- trailing column so CREATE OR REPLACE can evolve it without a drop.
CREATE OR REPLACE VIEW public.v_player_weapon_kills AS
SELECT
    pk.attacker_steam_id AS player_steam_id,
    m.source             AS source,
    pk."with"            AS "with",
    COUNT(*)             AS kill_count,
    mo.type              AS type
FROM player_kills pk
    INNER JOIN matches m ON m.id = pk.match_id
    LEFT JOIN match_options mo ON mo.id = m.match_options_id
WHERE pk.attacker_steam_id IS NOT NULL
  AND pk."with" IS NOT NULL
GROUP BY pk.attacker_steam_id, m.source, pk."with", mo.type;
