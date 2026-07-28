export interface MatchmakingTeam {
  lobbies: string[];
  players: Array<{
    rank: number;
    steam_id: string;
    // The lobby this player queued with, carried per-player so the match
    // can record who partied with whom. Absent for solo queuers.
    lobby_id?: string;
  }>;
  avgRank: number;
}
