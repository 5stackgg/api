-- Revert to the Premier-only history shape.
DROP INDEX IF EXISTS public.idx_player_premier_rank_history_steam_type_observed;
DROP INDEX IF EXISTS public.uq_player_premier_rank_history_steam_match_type;

-- Non-premier rows have no place in the premier-only table.
DELETE FROM public.player_premier_rank_history WHERE rank_type <> 11;

ALTER TABLE "public"."player_premier_rank_history"
  DROP COLUMN IF EXISTS "rank_type",
  DROP COLUMN IF EXISTS "previous_rank";

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_premier_rank_history_steam_match
  ON public.player_premier_rank_history (steam_id, match_id);

ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "competitive_rank",
  DROP COLUMN IF EXISTS "competitive_rank_updated_at",
  DROP COLUMN IF EXISTS "wingman_rank",
  DROP COLUMN IF EXISTS "wingman_rank_updated_at";
