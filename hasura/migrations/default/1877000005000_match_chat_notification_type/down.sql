UPDATE public.notifications SET type = 'ChatMessage' WHERE type = 'MatchChatMessage';

DELETE FROM public.e_notification_types WHERE value = 'MatchChatMessage';
