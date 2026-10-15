UPDATE public.settings
   SET value = '86400'
 WHERE name = 'public.chat_ttl_organizers'
   AND value = '7776000';
