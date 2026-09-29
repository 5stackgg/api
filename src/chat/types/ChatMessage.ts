import { e_player_roles_enum } from "generated";

export type ChatMessageSource = "web" | "game";

export interface ChatMessage {
  id: string;
  message: string;
  timestamp: string;
  // Absent on messages stored before it was recorded.
  source?: ChatMessageSource;
  from: {
    role: e_player_roles_enum;
    name: string;
    // Always a string: a 17 digit steam id does not survive being a JSON number.
    steam_id: string;
    avatar_url?: string;
    profile_url?: string;
  };
}
