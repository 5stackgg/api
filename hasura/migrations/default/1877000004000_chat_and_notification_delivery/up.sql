-- Chat storage and the notification delivery gate, whole.
--
-- Every statement here is idempotent, and has to stay that way. This shipped
-- once as 1877000003000 and gained columns afterwards; stacks that had already
-- applied that version would never see the rest, so the version was bumped to
-- re-run the lot over whatever they already have. That is also why the
-- reconciliation blocks below exist rather than the CREATE TABLEs simply being
-- correct -- CREATE TABLE IF NOT EXISTS silently skips a table that is already
-- there in an older shape.
--
-- Read cursors for every chat thread, not just DMs.
--
-- Redis held these before, for `direct` only. They move to Postgres because a
-- Redis restart would reset every cursor at once, and the next message in every
-- thread on the platform would then look unread and push -- the exact storm
-- this table exists to prevent. The push recipient query is Postgres already,
-- so joining here costs no extra round trip.
--
-- `thread` is the thread key, whole -- `chat:match:<id>`, `chat:direct:<a>:<b>`.
-- The same string is what the device collapses the notification on, what the
-- delivery window is keyed by, and what a focused client reports. Storing it
-- verbatim rather than as parsed halves is what lets the push recipient query
-- join on a single equality instead of picking the id apart in SQL.
-- See src/notifications/push/notification-delivery.ts.
CREATE TABLE IF NOT EXISTS "public"."chat_read_state" (
    "steam_id" bigint NOT NULL,
    "thread" text NOT NULL,
    "last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("steam_id", "thread"),
    FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

-- An early cut of this table keyed the cursor as (thread_type, thread_id).
-- Carried forward rather than dropped: these are what stop a push firing for a
-- conversation that has already been read, and resetting them all at once is
-- the storm the table exists to prevent.
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

    -- Two rows could collapse onto one key only if the same thread was stored
    -- twice, which the old primary key already prevented.
    ALTER TABLE public.chat_read_state DROP CONSTRAINT IF EXISTS chat_read_state_pkey;
    ALTER TABLE public.chat_read_state DROP COLUMN IF EXISTS thread_type;
    ALTER TABLE public.chat_read_state DROP COLUMN IF EXISTS thread_id;
    ALTER TABLE public.chat_read_state ALTER COLUMN thread SET NOT NULL;
    ALTER TABLE public.chat_read_state ADD PRIMARY KEY (steam_id, thread);
  END IF;
END $$;

-- Direct messages, durable.
--
-- Lobby chat stays in Redis: it is high volume, disposable, and dies with the
-- match. A DM is a conversation people expect to still be there, and a year of
-- them is the wrong thing to hold in RAM behind a TTL that a flush erases.
-- `seq` breaks ties on created_at, which is the sender's own clock and so is
-- routinely identical for two messages fired off together. Without it the
-- order two messages sent in the same millisecond come back in is whatever the
-- planner felt like.
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

-- `seq` arrived after the table did, so a stack on the earlier version has the
-- table without it and CREATE TABLE IF NOT EXISTS above left it alone. This is
-- what "column dm.seq does not exist" was.
ALTER TABLE "public"."direct_messages"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL;

-- Dropped rather than IF NOT EXISTS: the index of this name may already exist
-- without `seq` in it, in which case creating it again is a no-op and the tie
-- break never gets an index to use.
DROP INDEX IF EXISTS "public"."direct_messages_room_id_created_at_idx";

CREATE INDEX "direct_messages_room_id_created_at_idx"
    ON "public"."direct_messages" ("room_id", "created_at" DESC, "seq" DESC);

-- One row per (room, participant), so listing someone's conversations newest
-- first is one indexed read.
--
-- room_id encodes both steam ids, but finding "every room containing me" out of
-- that means a LIKE against an unanchored pattern. This is the index that makes
-- the inbox cheap, and it is what the unread count joins against.
CREATE TABLE IF NOT EXISTS "public"."direct_conversations" (
    "room_id" text NOT NULL,
    "steam_id" bigint NOT NULL,
    "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("room_id", "steam_id"),
    FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "direct_conversations_steam_id_last_message_at_idx"
    ON "public"."direct_conversations" ("steam_id", "last_message_at" DESC);

-- The DM rail is a hot bar the player arranges, not a list of every
-- conversation they have ever had.
--
-- Which conversations are on it used to live in localStorage, which meant it
-- was per-browser and disagreed across devices. It belongs here: the row is
-- already per (room, participant), so recording it says nothing to the other
-- party -- which was the original reason for keeping it off the server.
ALTER TABLE "public"."direct_conversations"
  ADD COLUMN IF NOT EXISTS "is_open" boolean NOT NULL DEFAULT true,
  -- Explicit order, lowest first. New conversations take min - 1 so they land
  -- at the top without disturbing anything the player has arranged below.
  -- Rewritten wholesale on a drag, so the values never need rebalancing.
  ADD COLUMN IF NOT EXISTS "position" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "direct_conversations_steam_id_position_idx"
    ON "public"."direct_conversations" ("steam_id", "position");

-- Rows that predate the column all sit at 0, which would make their order
-- arbitrary. Seed them from the ordering they were being displayed in.
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

-- Everything the push payload needs that the row itself cannot say: which
-- thread it belongs to, what that thread is called, whose avatar to show.
--
-- Without it a bundled "4 new messages" push would have to re-resolve the
-- conversation's name at delivery time, minutes after the fact and from a
-- worker that has no business knowing what a match lineup is.
ALTER TABLE "public"."notifications"
    ADD COLUMN IF NOT EXISTS "data" jsonb;

-- Chat retention, per lobby type.
--
-- There was one setting, `chat_message_ttl`, and it never did anything: the web
-- form writes `public.chat_message_ttl` while the API reads the unprefixed
-- name, so ChatService has run on its hard-coded 3600s default since the day it
-- shipped. Everything is `public.`-prefixed here so both halves agree, and any
-- value an operator did set is carried forward into the lobby TTLs rather than
-- silently reset.
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
     ORDER BY name
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
