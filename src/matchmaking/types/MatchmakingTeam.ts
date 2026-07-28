export interface MatchmakingTeam {
  lobbies: string[];
  players: Array<{
    rank: number;
    steam_id: string;
  }>;
  avgRank: number;
}
