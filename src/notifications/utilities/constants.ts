import { e_match_status_enum } from "generated/schema";

export const STATUS_LABELS: Record<e_match_status_enum, string> = {
  PickingPlayers: "Picking Players",
  Scheduled: "Scheduled",
  WaitingForCheckIn: "Waiting for Check-In",
  WaitingForServer: "Waiting for Server",
  Veto: "Veto",
  Live: "Live",
  Finished: "Finished",
  Tie: "Tie",
  Canceled: "Canceled",
  Forfeit: "Forfeit",
  Surrendered: "Surrendered",
};

export const DISCORD_COLORS = {
  GREEN: 0x2d6644,
  ORANGE: 0xe67e22,
  RED: 0xd7463d,
  GRAY: 0x95a5a6,
} as const;

export const NOTIFIABLE_STATUSES: ReadonlySet<e_match_status_enum> = new Set([
  "WaitingForCheckIn",
  "Live",
  "Finished",
  "Tie",
  "Canceled",
  "Forfeit",
  "Surrendered",
]);

export const STATUS_COLORS: Partial<Record<e_match_status_enum, number>> = {
  Live: DISCORD_COLORS.GREEN,
  Finished: DISCORD_COLORS.GREEN,
  Tie: DISCORD_COLORS.GREEN,
  Veto: DISCORD_COLORS.GREEN,
  WaitingForCheckIn: DISCORD_COLORS.GREEN,
  Canceled: DISCORD_COLORS.RED,
  Forfeit: DISCORD_COLORS.RED,
  Surrendered: DISCORD_COLORS.RED,
  WaitingForServer: DISCORD_COLORS.RED,
};
