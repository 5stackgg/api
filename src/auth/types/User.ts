import { e_player_roles_enum } from "generated";

export interface User {
  name: string;
  role: e_player_roles_enum;
  steam_id: string;
  country?: string;
  profile_url?: string;
  avatar_url?: string;
  discord_id?: string;
}
