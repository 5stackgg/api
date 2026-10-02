-- Banned-teammate pushes used to be part of account, so an account opt-out carries over.
INSERT INTO public.notification_preferences (steam_id, channel, key, enabled)
SELECT steam_id, channel, 'teammate_bans', false
  FROM public.notification_preferences
 WHERE channel = 'push'
   AND key = 'account'
   AND enabled = false
ON CONFLICT (steam_id, channel, key) DO NOTHING;
