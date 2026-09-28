import { ChatErrorCode } from "../enums/ChatErrorCode";

export type ChatSendResult =
  | { accepted: true }
  | { accepted: false; code?: ChatErrorCode };
