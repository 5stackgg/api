import { MatchmakingLobby } from "./MatchmakingLobby";

export interface BalancedTeams {
  team1: MatchmakingLobby[];
  team2: MatchmakingLobby[];
  // claimed but left out of the match - the caller has to requeue these
  unused: MatchmakingLobby[];
  avgRankDifference: number;
  spread: number;
  cost: number;
  nodesVisited: number;
  // false when the search hit the node budget or bailed early on a good enough
  // split, so the result is the best seen rather than provably optimal
  exhausted: boolean;
}

export interface MatchCandidates {
  anchor: MatchmakingLobby;
  // anchor first, then every other lobby in preference order
  candidates: MatchmakingLobby[];
}
