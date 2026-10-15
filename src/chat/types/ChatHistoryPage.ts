import { ChatMessage } from "./ChatMessage";

export interface ChatHistoryPage {
  // Oldest first.
  messages: ChatMessage[];
  // Whether anything older is left to ask for.
  more: boolean;
  // Handed back as `before` for the page after this one; null when the page
  // is empty.
  cursor: string | null;
}
