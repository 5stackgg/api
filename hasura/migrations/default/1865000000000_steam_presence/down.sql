DELETE FROM public.e_notification_types WHERE "value" = 'MatchImported';

DROP INDEX IF EXISTS public.idx_steam_accounts_role;
ALTER TABLE "public"."steam_accounts"
  DROP COLUMN IF EXISTS "friend_capacity",
  DROP COLUMN IF EXISTS "steamid64",
  DROP COLUMN IF EXISTS "role";

DROP INDEX IF EXISTS public.idx_player_steam_bot_friend_account;
DROP TABLE IF EXISTS "public"."player_steam_bot_friend";
