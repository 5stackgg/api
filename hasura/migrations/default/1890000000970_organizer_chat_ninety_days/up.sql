-- 86400 is what 1877000006000 seeded; any other value is an operator's choice.
UPDATE public.settings
   SET value = '7776000'
 WHERE name = 'public.chat_ttl_organizers'
   AND value = '86400';
