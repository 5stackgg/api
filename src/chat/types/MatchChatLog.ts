import { MatchChatArchiveEntry } from "./MatchChatArchiveEntry";

export interface MatchChatLog {
  match: MatchChatArchiveEntry[];
  teams: Array<{ lineup_id: string; messages: MatchChatArchiveEntry[] }>;
  team_chat_withheld: boolean;
  expires_at: string | null;
}
