-- Player columns for Premier rank snapshot.
ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "premier_rank" integer,
  ADD COLUMN IF NOT EXISTS "premier_rank_updated_at" timestamptz;

-- Per-user Steam match-history linkage (auth_code + last_known_share_code).
CREATE TABLE IF NOT EXISTS "public"."player_steam_match_auth" (
  "steam_id" bigint NOT NULL,
  "auth_code" text NOT NULL,
  "last_known_share_code" text NOT NULL,
  "last_polled_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("steam_id"),
  FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

-- Premier as a first-class match type alongside Competitive/Wingman/Duel.
INSERT INTO public.e_match_types ("value", "description") VALUES
  ('Premier', 'Valve Premier matchmaking — 5 vs 5 with CS Rating')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

-- Tag every match with where it came from. Default keeps existing rows on '5stack'.
ALTER TABLE "public"."matches"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT '5stack';

-- Indexes for the source-filtered query mix.
CREATE INDEX IF NOT EXISTS idx_matches_5stack_ended_at
  ON public.matches (ended_at DESC)
  WHERE source = '5stack' AND ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matches_external_created_at
  ON public.matches (source, created_at DESC)
  WHERE source <> '5stack';

CREATE INDEX IF NOT EXISTS idx_match_map_demos_file
  ON public.match_map_demos (file);

CREATE INDEX IF NOT EXISTS idx_players_last_sign_in_at
  ON public.players (last_sign_in_at DESC)
  WHERE last_sign_in_at IS NOT NULL;

-- Pending-import queue: one row per valve_match_id, many requesters.
CREATE TABLE IF NOT EXISTS "public"."pending_match_imports" (
  "valve_match_id" numeric NOT NULL,
  "share_code" text NOT NULL,
  "status" text NOT NULL DEFAULT 'Queued',
  "error" text,
  "map_name" text,
  "match_start_time" timestamptz,
  "demo_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("valve_match_id")
);

CREATE INDEX IF NOT EXISTS idx_pending_match_imports_status
  ON public.pending_match_imports (status);

CREATE TABLE IF NOT EXISTS "public"."pending_match_import_players" (
  "valve_match_id" numeric NOT NULL,
  "steam_id" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("valve_match_id", "steam_id"),
  FOREIGN KEY ("valve_match_id") REFERENCES "public"."pending_match_imports"("valve_match_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS idx_pending_match_import_players_steam_id
  ON public.pending_match_import_players (steam_id);

-- Premier rank snapshots, keyed by (player, match) so retries upsert
-- and match deletion cascades cleanly.
CREATE TABLE IF NOT EXISTS "public"."player_premier_rank_history" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "steam_id" bigint NOT NULL,
  "rank" integer NOT NULL,
  "match_id" uuid NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON UPDATE cascade ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS idx_player_premier_rank_history_steam_observed
  ON public.player_premier_rank_history (steam_id, observed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_premier_rank_history_steam_match
  ON public.player_premier_rank_history (steam_id, match_id);

-- match_map_demos.match_id was the only RESTRICT FK to matches; flip it
-- to CASCADE so `DELETE FROM matches` cleans up the demo metadata row.
ALTER TABLE "public"."match_map_demos"
  DROP CONSTRAINT IF EXISTS "match_demos_match_id_fkey";

ALTER TABLE "public"."match_map_demos"
  ADD CONSTRAINT "match_demos_match_id_fkey"
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;
