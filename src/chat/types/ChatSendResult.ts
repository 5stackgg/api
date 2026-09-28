import { ChatErrorCode } from "../enums/ChatErrorCode";

export type ChatSendResult =
  | { accepted: true; messageId: string }
  | { accepted: false; code?: ChatErrorCode };
