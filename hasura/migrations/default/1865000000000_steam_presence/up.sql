-- Tracks which players have added a 5stack presence bot as a Steam friend, so
-- the bot can watch their live match state and trigger near-real-time imports.
CREATE TABLE IF NOT EXISTS "public"."player_steam_bot_friend" (
  "steam_id" bigint NOT NULL,
  -- Which pool account they friended (nullable in the single-bot phase).
  "bot_steam_account_id" uuid,
  "bot_steamid64" bigint,
  -- 'pending' (invite shown, not yet accepted) | 'friends'
  "status" text NOT NULL DEFAULT 'pending',
  "last_presence_state" jsonb,
  "friended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("steam_id"),
  FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("bot_steam_account_id") REFERENCES "public"."steam_accounts"("id") ON UPDATE cascade ON DELETE set null
);

-- Find all friends assigned to a given bot account (capacity / sharding).
CREATE INDEX IF NOT EXISTS idx_player_steam_bot_friend_account
  ON public.player_steam_bot_friend (bot_steam_account_id);

-- Partition the shared pool: an account is used EITHER for GPU work (logging in
-- on a game node to watch demos/render) OR as a presence "friends" bot — never
-- both, since a Steam account can only be logged in one place at a time. The
-- GPU claimer (claim_free_steam_account) filters role='gpu', so friends accounts
-- are never handed to a GPU job.
ALTER TABLE "public"."steam_accounts"
  ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'gpu',
  ADD COLUMN IF NOT EXISTS "steamid64" bigint,
  ADD COLUMN IF NOT EXISTS "friend_capacity" integer NOT NULL DEFAULT 250;

CREATE INDEX IF NOT EXISTS idx_steam_accounts_role
  ON public.steam_accounts (role);

-- Notification fired when a player's Valve match is auto-imported.
INSERT INTO public.e_notification_types ("value", "description") VALUES
  ('MatchImported', 'A Valve match you played was imported to 5stack')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";
