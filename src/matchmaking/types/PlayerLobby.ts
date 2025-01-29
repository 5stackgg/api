import { e_match_types_enum } from "generated";

export interface PlayerLobby {
  id: string;
  players: Array<{
    steam_id: string;
    is_banned: boolean;
    matchmaking_cooldown: boolean;
  }>;
}
