ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_PickingPlayers" TO discord_notify_pickingplayers;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_Scheduled" TO discord_notify_scheduled;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_WaitingForCheckIn" TO discord_notify_waitingforcheckin;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_WaitingForServer" TO discord_notify_waitingforserver;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_Veto" TO discord_notify_veto;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_Live" TO discord_notify_live;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_Finished" TO discord_notify_finished;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_Tie" TO discord_notify_tie;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_Canceled" TO discord_notify_canceled;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_Forfeit" TO discord_notify_forfeit;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_Surrendered" TO discord_notify_surrendered;
ALTER TABLE public.tournaments
  RENAME COLUMN "discord_notify_MapPaused" TO discord_notify_mappaused;
