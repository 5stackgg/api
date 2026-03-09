import { getDiscordDisplayName } from "./getDiscordDisplayName";

describe("getDiscordDisplayName", () => {
  it("returns globalName when available", () => {
    const user = { id: "1", globalName: "CoolPlayer", username: "coolplayer" };
    expect(getDiscordDisplayName(user)).toBe("CoolPlayer");
  });

  it("falls back to username when globalName is empty", () => {
    const user = { id: "1", globalName: "", username: "coolplayer" };
    expect(getDiscordDisplayName(user)).toBe("coolplayer");
  });
});
