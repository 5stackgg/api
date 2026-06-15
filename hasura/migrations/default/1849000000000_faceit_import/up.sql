CREATE TABLE IF NOT EXISTS "public"."player_faceit_rank_history" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "steam_id" bigint NOT NULL,
  "elo" integer NOT NULL,
  "skill_level" integer,
  "previous_rank" integer,
  "match_id" uuid NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON UPDATE cascade ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_faceit_rank_history_steam_match
  ON public.player_faceit_rank_history (steam_id, match_id);

CREATE INDEX IF NOT EXISTS idx_player_faceit_rank_history_steam_observed
  ON public.player_faceit_rank_history (steam_id, observed_at DESC);

ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "faceit_synced_at" timestamptz;

UPDATE "public"."match_options" SET "type" = 'Competitive' WHERE "type" = 'Faceit';
