export interface MatchmakingTeam {
  lobbies: string[];
  players: Array<{
    rank: number;
    steam_id: string;
    // Absent for solo queuers.
    lobby_id?: string;
  }>;
  avgRank: number;
}
