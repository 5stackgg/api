UPDATE public.settings
   SET value = '86400'
 WHERE name = 'public.chat_ttl_tournament'
   AND value = '604800';

ALTER TABLE public.tournaments
    DROP COLUMN IF EXISTS finished_at;
