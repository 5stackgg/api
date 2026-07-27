import { MatchmakingLobby } from "./MatchmakingLobby";

export interface BalancedTeams {
  team1: MatchmakingLobby[];
  team2: MatchmakingLobby[];
  /**
   * Candidates this match did not take. Informational only - it is NOT the set
   * to requeue. createMatches keeps unused lobbies claimed so it can carve the
   * next match out of them, and tracks requeue ownership itself so that the
   * "no valid split" path (where there is no BalancedTeams at all) is covered
   * by the same bookkeeping.
   */
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
