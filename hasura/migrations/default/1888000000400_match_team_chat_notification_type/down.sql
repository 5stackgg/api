UPDATE public.notifications
   SET type = 'ChatMessage'
 WHERE type = 'MatchChatMessage'
   AND entity_id LIKE 'match\_team:%' ESCAPE '\';
