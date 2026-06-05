-- Per (match_map, killer, victim, weapon) inter-team kill counts with each
-- side, so the Opening Duels "most killed / most died to / best weapon"
-- breakdown reads aggregates instead of scanning every kill. killer_side /
-- victim_side let the consumer apply the side filter from whichever end the
-- player sits on.
CREATE OR REPLACE VIEW public.v_match_kill_pairs AS
SELECT
  mm.match_id,
  pk.match_map_id,
  pk.attacker_steam_id AS killer_steam_id,
  pk.attacked_steam_id AS victim_steam_id,
  pk."with" AS weapon,
  public.normalize_side(pk.attacker_team) AS killer_side,
  public.normalize_side(pk.attacked_team) AS victim_side,
  COUNT(*)::int AS kills
FROM public.player_kills pk
JOIN public.match_maps mm ON mm.id = pk.match_map_id
WHERE pk.attacker_steam_id IS NOT NULL
  AND pk.attacker_team <> pk.attacked_team
  AND pk.attacker_steam_id <> pk.attacked_steam_id
GROUP BY
  mm.match_id,
  pk.match_map_id,
  pk.attacker_steam_id,
  pk.attacked_steam_id,
  pk."with",
  public.normalize_side(pk.attacker_team),
  public.normalize_side(pk.attacked_team);
