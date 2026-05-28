-- Generalize the Premier-only rank history into a multi-rank-type history so
-- external Competitive (rank_type 12) and Wingman (7) ranks are tracked per
-- match alongside Premier (11). The physical table keeps its name to avoid
-- churning the GraphQL root field / relationship; it just gains a rank_type
-- discriminator and a previous_rank so the per-match delta is exact.

ALTER TABLE "public"."player_premier_rank_history"
  ADD COLUMN IF NOT EXISTS "rank_type" integer NOT NULL DEFAULT 11,
  ADD COLUMN IF NOT EXISTS "previous_rank" integer;

-- Per-player snapshots for the new rank types (premier_rank already exists).
ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "competitive_rank" integer,
  ADD COLUMN IF NOT EXISTS "competitive_rank_updated_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "wingman_rank" integer,
  ADD COLUMN IF NOT EXISTS "wingman_rank_updated_at" timestamptz;

-- Backfill previous_rank for existing rows (chronological per player + type).
WITH ordered AS (
  SELECT
    id,
    lag(rank) OVER (
      PARTITION BY steam_id, rank_type
      ORDER BY observed_at, id
    ) AS prev
  FROM public.player_premier_rank_history
)
UPDATE public.player_premier_rank_history h
   SET previous_rank = o.prev
  FROM ordered o
 WHERE h.id = o.id
   AND h.previous_rank IS NULL;

-- A match observes one rank value per (player, rank_type); make that the
-- uniqueness key so retries upsert correctly across rank types.
DROP INDEX IF EXISTS public.uq_player_premier_rank_history_steam_match;
CREATE UNIQUE INDEX IF NOT EXISTS uq_player_premier_rank_history_steam_match_type
  ON public.player_premier_rank_history (steam_id, match_id, rank_type);

-- Lookup index for "this player's history of a given rank type".
CREATE INDEX IF NOT EXISTS idx_player_premier_rank_history_steam_type_observed
  ON public.player_premier_rank_history (steam_id, rank_type, observed_at DESC);
