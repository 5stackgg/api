import { MatchChatArchiveEntry } from "./MatchChatArchiveEntry";

export interface MatchChatLog {
  match: MatchChatArchiveEntry[];
  teams: Array<{ lineup_id: string; messages: MatchChatArchiveEntry[] }>;
  team_chat_withheld: boolean;
  // Hit its per-match cap, so later lines were not kept.
  archive_truncated: boolean;
  expires_at: string | null;
}
