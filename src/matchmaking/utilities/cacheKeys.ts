import { e_match_types_enum } from "generated";

export function getMatchmakingQueueCacheKey(
  type: e_match_types_enum,
  region: string,
) {
  return `matchmaking:v1:${region}:${type}`;
}

export function getMatchmakingDetailsCacheKey(lobbyId: string) {
  return `matchmaking:v1:details:${lobbyId}`;
}

export function getMatchmakingConformationCacheKey(confirmationId: string) {
  return `matchmaking:v1:${confirmationId}`;
}

export function getMatchmakingRankCacheKey(
  type: e_match_types_enum,
  region: string,
) {
  return `matchmaking:v1:${region}:${type}:ranks`;
}
