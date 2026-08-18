-- Match chat gets its own notification type, and so its own push category.
--
-- Every line typed in-game is relayed into the match's chat by
-- ChatMessageEvent, so a live match fans out a notification per lineup member
-- per line -- callouts, banter, both teams. The delivery gate suppresses that
-- for anyone with the conversation on screen, but a player who is actually in
-- CS2 has no web page focused, so the one person guaranteed to be reading the
-- messages already is the one whose phone buzzes for them.
--
-- Splitting the type is what lets a player mute match chat without also
-- muting direct messages, which the single `chat` category could not express.
INSERT INTO public.e_notification_types ("value", "description") VALUES
  ('MatchChatMessage', 'A new message in a match''s chat')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

-- Existing match-chat rows have to move with the type.
--
-- markThreadRead clears a match thread by looking for MatchChatMessage, so
-- anything left behind as ChatMessage would sit unread in the bell forever --
-- no longer reachable by the read-clear, and no longer collapsed by the
-- collapse.
--
-- `LIKE 'match:%'` and not `'match%'`: a match_team room's entity_id starts
-- `match_team:`, and team chat keeps the plain type.
UPDATE public.notifications
   SET type = 'MatchChatMessage'
 WHERE type = 'ChatMessage'
   AND entity_id LIKE 'match:%';
