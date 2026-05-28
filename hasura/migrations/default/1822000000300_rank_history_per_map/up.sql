-- CS2 Competitive & Wingman skill groups are PER MAP, not a single global
-- value (unlike Premier's global CS Rating). So:
--   * record map_id on each rank-history row (skill-group types only),
--   * recompute previous_rank PER MAP so the per-match delta is map-correct,
--   * drop the incorrect global competitive/wingman snapshot columns.
-- Premier (rank_type 11) stays global: its history rows keep map_id NULL.

ALTER TABLE "public"."player_premier_rank_history"
  ADD COLUMN IF NOT EXISTS "map_id" uuid;

ALTER TABLE "public"."player_premier_rank_history"
  DROP CONSTRAINT IF EXISTS "player_rank_history_map_id_fkey";
ALTER TABLE "public"."player_premier_rank_history"
  ADD CONSTRAINT "player_rank_history_map_id_fkey"
  FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id")
  ON UPDATE CASCADE ON DELETE SET NULL;

-- Backfill map_id for the skill-group types from each row's match map.
-- External MM matches are single-map; premier rows stay NULL (global).
UPDATE public.player_premier_rank_history h
   SET map_id = mm.map_id
  FROM public.match_maps mm
 WHERE mm.match_id = h.match_id
   AND h.rank_type IN (6, 7)
   AND h.map_id IS NULL;

-- Recompute previous_rank per map for the skill-group types.
WITH ordered AS (
  SELECT
    id,
    lag(rank) OVER (
      PARTITION BY steam_id, rank_type, map_id
      ORDER BY observed_at, id
    ) AS prev
  FROM public.player_premier_rank_history
  WHERE rank_type IN (6, 7)
)
UPDATE public.player_premier_rank_history h
   SET previous_rank = o.prev
  FROM ordered o
 WHERE h.id = o.id;

-- Per-(player, type, map) lookup for "this player's skill group on this map".
CREATE INDEX IF NOT EXISTS idx_player_rank_history_steam_type_map_observed
  ON public.player_premier_rank_history (steam_id, rank_type, map_id, observed_at DESC);

-- The global skill-group snapshots are meaningless per-map — drop them.
ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "competitive_rank",
  DROP COLUMN IF EXISTS "competitive_rank_updated_at",
  DROP COLUMN IF EXISTS "wingman_rank",
  DROP COLUMN IF EXISTS "wingman_rank_updated_at";
