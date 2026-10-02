DELETE FROM public.notifications
 WHERE type IN ('ChatMessage', 'MatchChatMessage');

DELETE FROM public.notification_preferences
 WHERE channel = 'in_app'
   AND key IN ('ChatMessage', 'MatchChatMessage');

DROP INDEX IF EXISTS public.notifications_message_id_idx;
