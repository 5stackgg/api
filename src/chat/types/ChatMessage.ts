import { e_player_roles_enum } from "generated";
import { ChatReactions } from "./ChatReactions";

export type ChatMessageSource = "web" | "game";

export interface ChatMessage {
  id: string;
  message: string;
  timestamp: string;
  // Absent on messages stored before it was recorded.
  source?: ChatMessageSource;
  // ISO 8601, present once the author has edited the message.
  edited_at?: string;
  // Added when a message is sent to clients, never stored in its JSON: an
  // edit's compare-and-set would otherwise contend with every reaction.
  reactions?: ChatReactions;
  from: {
    role: e_player_roles_enum;
    name: string;
    // Always a string: a 17 digit steam id does not survive being a JSON number.
    steam_id: string;
    avatar_url?: string;
    profile_url?: string;
  };
}
