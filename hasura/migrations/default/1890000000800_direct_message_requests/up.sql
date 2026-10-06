-- Direct messages are no longer limited to friends. Anyone may send a player
-- one message, which lands in that player's requests; replying accepts it, and
-- until then the sender cannot send another. A player can turn requests off,
-- leaving only friends able to start a conversation with them.
ALTER TABLE public.players
    ADD COLUMN IF NOT EXISTS allow_message_requests boolean NOT NULL DEFAULT true;

-- Per participant: accepted_at is when this side took part in the conversation
-- (sent in it, or was a friend when it was written to), so NULL on a row is a
-- request waiting on that player. declined_at hides a request without
-- deleting the row the other side's rail still resolves its peer through.
ALTER TABLE public.direct_conversations
    ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
    ADD COLUMN IF NOT EXISTS declined_at timestamptz;

-- Every conversation so far was between friends.
UPDATE public.direct_conversations
   SET accepted_at = last_message_at
 WHERE accepted_at IS NULL;
