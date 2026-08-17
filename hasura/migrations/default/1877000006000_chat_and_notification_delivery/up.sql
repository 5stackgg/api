-- Chat storage and the notification delivery gate.
--
-- Idempotent throughout: the version is bumped whenever this changes (was
-- 1877000003000, then 1877000004000) so stacks on an earlier cut re-run it.

-- Read cursors for every chat thread, not just DMs. `thread` is the whole key
-- (`chat:match:<id>`), which is what the push recipient query joins on.
CREATE TABLE IF NOT EXISTS "public"."chat_read_state" (
    "steam_id" bigint NOT NULL,
    "thread" text NOT NULL,
    "last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("steam_id", "thread"),
    FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

-- An early cut keyed the cursor as (thread_type, thread_id). Carried forward
-- rather than dropped: resetting every cursor at once is a push storm.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'chat_read_state'
       AND column_name = 'thread_type'
  ) THEN
    ALTER TABLE public.chat_read_state ADD COLUMN IF NOT EXISTS thread text;

    UPDATE public.chat_read_state
       SET thread = 'chat:' || thread_type || ':' || thread_id
     WHERE thread IS NULL;

    ALTER TABLE public.chat_read_state DROP CONSTRAINT IF EXISTS chat_read_state_pkey;
    ALTER TABLE public.chat_read_state DROP COLUMN IF EXISTS thread_type;
    ALTER TABLE public.chat_read_state DROP COLUMN IF EXISTS thread_id;
    ALTER TABLE public.chat_read_state ALTER COLUMN thread SET NOT NULL;
    ALTER TABLE public.chat_read_state ADD PRIMARY KEY (steam_id, thread);
  END IF;
END $$;

-- DMs are durable; lobby chat stays in redis. `seq` breaks ties on created_at,
-- which is the sender's clock and routinely identical for two quick messages.
CREATE TABLE IF NOT EXISTS "public"."direct_messages" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "seq" bigserial NOT NULL,
    "room_id" text NOT NULL,
    "from_steam_id" bigint NOT NULL,
    "message" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("id"),
    FOREIGN KEY ("from_steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

-- `seq` arrived after the table, so CREATE TABLE IF NOT EXISTS skips it above.
ALTER TABLE "public"."direct_messages"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL;

-- Dropped rather than IF NOT EXISTS: the old index of this name has no `seq`.
DROP INDEX IF EXISTS "public"."direct_messages_room_id_created_at_idx";

CREATE INDEX "direct_messages_room_id_created_at_idx"
    ON "public"."direct_messages" ("room_id", "created_at" DESC, "seq" DESC);

-- One row per (room, participant), so an inbox is one indexed read rather than
-- a LIKE over room_id.
CREATE TABLE IF NOT EXISTS "public"."direct_conversations" (
    "room_id" text NOT NULL,
    "steam_id" bigint NOT NULL,
    "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("room_id", "steam_id"),
    FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "direct_conversations_steam_id_last_message_at_idx"
    ON "public"."direct_conversations" ("steam_id", "last_message_at" DESC);

-- The DM rail: which conversations are on it and in what order, server side so
-- it agrees across devices. New conversations take min - 1 to land on top.
ALTER TABLE "public"."direct_conversations"
  ADD COLUMN IF NOT EXISTS "is_open" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "position" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "direct_conversations_steam_id_position_idx"
    ON "public"."direct_conversations" ("steam_id", "position");

-- Rows predating the column all sit at 0; seed them from how they were shown.
WITH ordered AS (
  SELECT room_id,
         steam_id,
         row_number() OVER (
           PARTITION BY steam_id ORDER BY last_message_at DESC
         ) AS rn
    FROM public.direct_conversations
)
UPDATE public.direct_conversations dc
   SET position = ordered.rn
  FROM ordered
 WHERE ordered.room_id = dc.room_id
   AND ordered.steam_id = dc.steam_id
   AND dc.position = 0;

-- Thread key, label and avatar for the push payload, so a bundled push does not
-- have to re-resolve the conversation at delivery time.
ALTER TABLE "public"."notifications"
    ADD COLUMN IF NOT EXISTS "data" jsonb;

-- Chat retention, per lobby type. The old `chat_message_ttl` never did
-- anything: the web form wrote it prefixed, the API read it unprefixed.
INSERT INTO public.settings (name, value)
SELECT name, value
  FROM (
    VALUES
      ('public.chat_ttl_match',            '3600'),
      ('public.chat_ttl_match_team',       '3600'),
      ('public.chat_ttl_matchmaking',      '3600'),
      ('public.chat_ttl_tournament',       '86400'),
      ('public.chat_ttl_organizers',       '86400'),
      ('public.chat_ttl_draft',            '3600'),
      ('public.chat_retention_direct_days', '365')
  ) AS defaults(name, value)
ON CONFLICT (name) DO NOTHING;

UPDATE public.settings s
   SET value = legacy.value
  FROM (
    SELECT value
      FROM public.settings
     WHERE name IN ('public.chat_message_ttl', 'chat_message_ttl')
       AND value ~ '^\d+$'
     -- Prefer the prefixed row: it is the one the settings form wrote.
     ORDER BY (name = 'public.chat_message_ttl') DESC
     LIMIT 1
  ) AS legacy
 WHERE s.name IN (
         'public.chat_ttl_match',
         'public.chat_ttl_match_team',
         'public.chat_ttl_matchmaking',
         'public.chat_ttl_draft'
       )
   AND s.value IN ('3600');

DELETE FROM public.settings
 WHERE name IN ('public.chat_message_ttl', 'chat_message_ttl');

-- Match chat gets its own type so it can be muted apart from DMs. Lives in
-- hasura/enums/notification-types.sql too; repeated here because enums are
-- applied after migrations and the backfill below needs the value now.
INSERT INTO public.e_notification_types ("value", "description") VALUES
  ('MatchChatMessage', 'A new message in a match''s chat')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

-- `LIKE 'match:%'` and not `'match%'`: match_team rooms keep the plain type.
UPDATE public.notifications
   SET type = 'MatchChatMessage'
 WHERE type = 'ChatMessage'
   AND entity_id LIKE 'match:%';
