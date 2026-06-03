-- Per-player weapon damage split by match source and type. Mirrors
-- v_player_weapon_kills but aggregates the damage events (which carry the
-- weapon + raw damage), so the weapons table can show total damage and
-- damage-per-kill alongside kills. `type` is the trailing column so
-- CREATE OR REPLACE can evolve it without a drop.
CREATE OR REPLACE VIEW public.v_player_weapon_damage AS
SELECT
    pd.attacker_steam_id AS player_steam_id,
    m.source             AS source,
    pd."with"            AS "with",
    SUM(pd.damage)::bigint AS damage,
    COUNT(*)::bigint       AS hits,
    mo.type              AS type
FROM player_damages pd
    INNER JOIN matches m ON m.id = pd.match_id
    LEFT JOIN match_options mo ON mo.id = m.match_options_id
WHERE pd.attacker_steam_id IS NOT NULL
  AND pd."with" IS NOT NULL
  AND pd.attacker_team <> pd.attacked_team
GROUP BY pd.attacker_steam_id, m.source, pd."with", mo.type;
