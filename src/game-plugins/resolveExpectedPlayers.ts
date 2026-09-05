import { e_match_types_enum } from "generated";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";

// A custom game mode may declare its own team size. Everything else -- every
// ranked type, and any mode that leaves players_per_team null -- keeps the fixed
// count the match type has always carried.
export interface GameModeSizing {
  players_per_team?: number | null;
  allow_short_handed_start?: boolean | null;
}

export function resolvePlayersPerTeam(
  type: e_match_types_enum,
  gameMode?: GameModeSizing | null,
): number {
  if (gameMode?.players_per_team) {
    return gameMode.players_per_team;
  }

  return ExpectedPlayers[type] / 2;
}

export function resolveCapacity(
  type: e_match_types_enum,
  gameMode?: GameModeSizing | null,
): number {
  return resolvePlayersPerTeam(type, gameMode) * 2;
}

export function allowsShortHandedStart(gameMode?: GameModeSizing | null) {
  return gameMode?.allow_short_handed_start === true;
}
