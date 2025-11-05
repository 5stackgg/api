export interface PlayerLobby {
  id: string;
  players: Array<{
    captain: boolean;
    name: string;
    steam_id: string;
    is_banned: boolean;
    matchmaking_cooldown: boolean;
  }>;
}
