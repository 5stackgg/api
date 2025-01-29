import { e_match_types_enum } from "generated";

const version = "v7";

export function getMatchmakingQueueCacheKey(
  type: e_match_types_enum,
  region: string,
) {
  return `matchmaking:${version}:${region}:${type}`;
}

export function getMatchmakingLobbyDetailsCacheKey(lobbyId: string) {
  return `matchmaking:${version}:details:${lobbyId}`;
}

export function getMatchmakingConformationCacheKey(confirmationId: string) {
  return `matchmaking:${version}:${confirmationId}`;
}

export function getMatchmakingRankCacheKey(
  type: e_match_types_enum,
  region: string,
) {
  return `matchmaking:${version}:${region}:${type}:ranks`;
}
