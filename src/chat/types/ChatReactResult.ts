import { ChatErrorCode } from "../enums/ChatErrorCode";
import { ChatReactions } from "./ChatReactions";

export type ChatReactResult =
  | { toggled: true; reactions: ChatReactions }
  | { toggled: false; code: ChatErrorCode };
