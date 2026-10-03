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
  // Each earlier version, the original first, with when it was written.
  edits?: Array<{ message: string; written_at: string }>;
  // Edits past the original were dropped to keep the archive under its cap.
  history_truncated?: boolean;
  deleted_at?: string;
  deleted_by?: {
    steam_id: string;
    name: string;
  };
}
