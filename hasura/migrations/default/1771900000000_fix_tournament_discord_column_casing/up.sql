-- Fix column casing: PostgreSQL stored these as lowercase because the original
-- migration didn't use double-quoted identifiers. Hasura metadata expects mixed case.
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_pickingplayers TO "discord_notify_PickingPlayers";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_scheduled TO "discord_notify_Scheduled";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_waitingforcheckin TO "discord_notify_WaitingForCheckIn";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_waitingforserver TO "discord_notify_WaitingForServer";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_veto TO "discord_notify_Veto";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_live TO "discord_notify_Live";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_finished TO "discord_notify_Finished";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_tie TO "discord_notify_Tie";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_canceled TO "discord_notify_Canceled";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_forfeit TO "discord_notify_Forfeit";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_surrendered TO "discord_notify_Surrendered";
ALTER TABLE public.tournaments
  RENAME COLUMN discord_notify_mappaused TO "discord_notify_MapPaused";
