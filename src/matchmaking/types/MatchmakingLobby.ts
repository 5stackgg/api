import { e_match_types_enum } from "generated";

export interface MatchmakingLobby {
  type: e_match_types_enum;
  regions: string[];
  joinedAt: Date;
  lobbyId: string;
  players: Array<{
    steam_id: string;
    rank: number;
  }>;
  regionPositions: Record<string, number>;
  avgRank: number;
}
