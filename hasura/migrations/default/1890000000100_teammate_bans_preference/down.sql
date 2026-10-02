DELETE FROM public.notification_preferences
 WHERE channel = 'push'
   AND key = 'teammate_bans';
