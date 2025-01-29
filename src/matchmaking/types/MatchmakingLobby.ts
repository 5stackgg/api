import { e_match_types_enum } from "generated";

export interface MatchmakingLobby {
  type: e_match_types_enum;
  regions: string[];
  joinedAt: Date;
  lobbyId: string;
  players: string[];
  regionPositions: Record<string, number>;
  avgRank: number;
}
