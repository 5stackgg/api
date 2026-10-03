import { ChatMessageSource } from "./ChatMessage";

export interface MatchChatArchiveEntry {
  id: string;
  // "match" for all chat, otherwise the lineup whose team room it was said in.
  room: string;
  message: string;
  timestamp: string;
  source?: ChatMessageSource;
  from: {
    steam_id: string;
    name: string;
  };
  edited_at?: string;
  // Each earlier text, with when it was replaced.
  edits?: Array<{ message: string; edited_at: string }>;
  deleted_at?: string;
  deleted_by?: string;
}
