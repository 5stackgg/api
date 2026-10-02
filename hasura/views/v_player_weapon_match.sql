-- Per-(player, match, weapon) kills and damage, so weapon stats can follow a
-- date range or season through the `match` relationship. v_player_weapon_kills
-- and v_player_weapon_damage stay the career rollups.
CREATE OR REPLACE VIEW public.v_player_weapon_match_kills AS
SELECT
    pk.attacker_steam_id AS player_steam_id,
    pk.match_id,
    pk."with"            AS "with",
    COUNT(*)::bigint     AS kill_count,
    COUNT(DISTINCT (pk.match_map_id, pk.round))::bigint AS rounds
FROM player_kills pk
WHERE pk.attacker_steam_id IS NOT NULL
  AND pk."with" IS NOT NULL
GROUP BY pk.attacker_steam_id, pk.match_id, pk."with";

CREATE OR REPLACE VIEW public.v_player_weapon_match_damage AS
SELECT
    pd.attacker_steam_id   AS player_steam_id,
    pd.match_id,
    pd."with"              AS "with",
    SUM(pd.damage)::bigint AS damage,
    COUNT(*)::bigint       AS hits
FROM player_damages pd
WHERE pd.attacker_steam_id IS NOT NULL
  AND pd."with" IS NOT NULL
  AND pd.attacker_team <> pd.attacked_team
GROUP BY pd.attacker_steam_id, pd.match_id, pd."with";
