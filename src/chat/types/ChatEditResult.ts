import { ChatErrorCode } from "../enums/ChatErrorCode";

export type ChatEditResult =
  | { edited: true; message: string; edited_at: string }
  | { edited: false; code: ChatErrorCode };
