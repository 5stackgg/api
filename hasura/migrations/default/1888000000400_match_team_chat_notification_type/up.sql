-- Team rooms now notify as MatchChatMessage (ChatService.notificationTypeFor),
-- and the read-clear and bell collapse look rows up by that type, so a row left
-- on the old one would sit unread forever. `_` is a LIKE wildcard, hence the
-- escape.
UPDATE public.notifications
   SET type = 'MatchChatMessage'
 WHERE type = 'ChatMessage'
   AND entity_id LIKE 'match\_team:%' ESCAPE '\';
