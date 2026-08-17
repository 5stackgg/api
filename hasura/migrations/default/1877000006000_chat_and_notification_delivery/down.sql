UPDATE public.notifications SET type = 'ChatMessage' WHERE type = 'MatchChatMessage';

DELETE FROM public.e_notification_types WHERE value = 'MatchChatMessage';

DELETE FROM public.settings
 WHERE name IN (
   'public.chat_ttl_match',
   'public.chat_ttl_match_team',
   'public.chat_ttl_matchmaking',
   'public.chat_ttl_tournament',
   'public.chat_ttl_organizers',
   'public.chat_ttl_draft',
   'public.chat_retention_direct_days'
 );

ALTER TABLE "public"."notifications" DROP COLUMN IF EXISTS "data";

DROP TABLE IF EXISTS "public"."direct_conversations";
DROP TABLE IF EXISTS "public"."direct_messages";
DROP TABLE IF EXISTS "public"."chat_read_state";
