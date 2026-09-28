import { ChatErrorCode } from "../enums/ChatErrorCode";

export type ChatDeleteResult =
  | { deleted: true }
  | { deleted: false; code: ChatErrorCode };
