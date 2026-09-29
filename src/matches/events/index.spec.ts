import { MatchEvents } from "./index";
import ChatMessageEvent from "./ChatMessageEvent";
import TeamChatMessageEvent from "./TeamChatMessageEvent";

describe("MatchEvents", () => {
  // the plugin sends team lines under their own name so that an api without
  // a handler for it drops them rather than posting them as all chat
  it("routes team chat and all chat to separate handlers", () => {
    expect(MatchEvents.chat).toBe(ChatMessageEvent);
    expect(MatchEvents.teamChat).toBe(TeamChatMessageEvent);
  });
});
