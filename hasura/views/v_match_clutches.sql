-- One read of each map's kill feed, grouped by round, rather than a lookup
-- per round: player_kills is chunked by time, so a lookup without one probes
-- every chunk. Rounds without kills hold no clutch and are skipped.
CREATE OR REPLACE VIEW public.v_match_clutches AS
SELECT
  mm.match_id,
  r.match_map_id,
  r.round,
  c.match_lineup_id,
  c.clutcher_steam_id,
  c.side,
  c.against_count,
  c.kills_in_clutch,
  c.outcome
FROM public.match_maps mm
JOIN public.matches m ON m.id = mm.match_id
CROSS JOIN LATERAL (
  SELECT
    COALESCE((SELECT array_agg(mlp.steam_id) FROM public.match_lineup_players mlp
               WHERE mlp.match_lineup_id = m.lineup_1_id AND mlp.steam_id IS NOT NULL), '{}') AS lineup_1_players,
    COALESCE((SELECT array_agg(mlp.steam_id) FROM public.match_lineup_players mlp
               WHERE mlp.match_lineup_id = m.lineup_2_id AND mlp.steam_id IS NOT NULL), '{}') AS lineup_2_players
) lp
CROSS JOIN LATERAL (
  SELECT pk.round,
         array_agg(ARRAY[pk.attacker_steam_id, pk.attacked_steam_id]
                   ORDER BY pk."time", pk.attacker_steam_id, pk.attacked_steam_id) AS kills
  FROM public.player_kills pk
  WHERE pk.match_map_id = mm.id AND pk.round > 0
  GROUP BY pk.round
) k
JOIN public.match_map_rounds r
  ON r.match_map_id = mm.id AND r.round = k.round AND r.deleted_at IS NULL
CROSS JOIN LATERAL public.clutch_from_kills(
  m.lineup_1_id,
  m.lineup_2_id,
  lp.lineup_1_players,
  lp.lineup_2_players,
  k.kills,
  public.normalize_side(r.lineup_1_side),
  public.normalize_side(r.lineup_2_side),
  public.normalize_side(r.winning_side)
) c;
