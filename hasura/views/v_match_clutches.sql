-- One row per clutch in the match, via detect_round_clutch() applied to every
-- finalized round. Backs the Clutches tab (group by lineup) and player clutch
-- stats.
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
FROM public.match_map_rounds r
JOIN public.match_maps mm ON mm.id = r.match_map_id
CROSS JOIN LATERAL public.detect_round_clutch(r.match_map_id, r.round) c
WHERE r.round > 0 AND r.deleted_at IS NULL;
