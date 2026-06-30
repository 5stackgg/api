import {
  parseCs2Presence,
  isMatchEndTransition,
  Cs2PresenceState,
} from "./presence";

describe("parseCs2Presence", () => {
  it("reports not in CS2 when gameid is missing", () => {
    expect(parseCs2Presence({})).toEqual({
      inCs2: false,
      inGame: false,
      inMatch: false,
      mode: null,
      map: null,
    });
  });

  it("reports not in CS2 for a different game", () => {
    const state = parseCs2Presence({ gameid: "570" });
    expect(state.inCs2).toBe(false);
    expect(state.inMatch).toBe(false);
  });

  it("in CS2 but at the main menu is not in a match", () => {
    const state = parseCs2Presence({
      gameid: "730",
      richPresence: { steam_display: "#display_Menu" },
    });
    expect(state.inCs2).toBe(true);
    expect(state.inMatch).toBe(false);
  });

  it("detects an active premier match", () => {
    const state = parseCs2Presence({
      gameid: 730,
      richPresence: {
        "game:state": "game",
        "game:mode": "premier",
        "game:map": "de_mirage",
        steam_display: "#display_GameKnownMapScore",
        "game:score": "5:3",
      },
    });
    expect(state).toEqual({
      inCs2: true,
      inGame: true,
      inMatch: true,
      mode: "premier",
      map: "de_mirage",
    });
  });

  it("detects an active competitive match", () => {
    const state = parseCs2Presence({
      gameid: "730",
      richPresence: {
        "game:state": "game",
        "game:mode": "competitive",
        "game:map": "mg_de_dust2",
      },
    });
    expect(state.inMatch).toBe(true);
    expect(state.mode).toBe("competitive");
    // mg_ prefix stripped
    expect(state.map).toBe("de_dust2");
  });

  it("treats casual / deathmatch as in-game but not a match we import", () => {
    const casual = parseCs2Presence({
      gameid: "730",
      richPresence: {
        "game:state": "game",
        "game:mode": "casual",
        "game:map": "de_dust2",
      },
    });
    expect(casual.inCs2).toBe(true);
    expect(casual.inGame).toBe(true);
    expect(casual.inMatch).toBe(false);
    expect(casual.mode).toBe("casual");

    const dm = parseCs2Presence({
      gameid: "730",
      richPresence: {
        "game:state": "game",
        "game:mode": "deathmatch",
        "game:map": "de_mirage",
      },
    });
    expect(dm.inGame).toBe(true);
    expect(dm.inMatch).toBe(false);
    expect(dm.mode).toBe("deathmatch");
  });

  it("treats a custom server match (no game:mode) as in-game", () => {
    const state = parseCs2Presence({
      gameid: "730",
      richPresence: {
        "game:state": "game",
        "game:map": "de_nuke",
      },
    });
    expect(state.inGame).toBe(true);
    expect(state.inMatch).toBe(false);
    expect(state.mode).toBeNull();
    expect(state.map).toBe("de_nuke");
  });

  it("menu is not in-game", () => {
    const state = parseCs2Presence({
      gameid: "730",
      richPresence: { steam_display: "#display_Menu", "game:mode": "competitive" },
    });
    expect(state.inGame).toBe(false);
    expect(state.inMatch).toBe(false);
  });

  it("accepts the array form of rich presence", () => {
    const state = parseCs2Presence({
      gameid: "730",
      richPresence: [
        { key: "game:state", value: "game" },
        { key: "game:mode", value: "competitive" },
        { key: "game:map", value: "de_inferno" },
      ],
    });
    expect(state.inMatch).toBe(true);
    expect(state.map).toBe("de_inferno");
  });
});

describe("isMatchEndTransition", () => {
  const inMatch: Cs2PresenceState = {
    inCs2: true,
    inGame: true,
    inMatch: true,
    mode: "premier",
    map: "de_mirage",
  };
  const menu: Cs2PresenceState = {
    inCs2: true,
    inGame: false,
    inMatch: false,
    mode: null,
    map: null,
  };
  const offline: Cs2PresenceState = {
    inCs2: false,
    inGame: false,
    inMatch: false,
    mode: null,
    map: null,
  };

  it("fires when a match ends back to menu", () => {
    expect(isMatchEndTransition(inMatch, menu)).toBe(true);
  });

  it("fires when a match ends by quitting the game", () => {
    expect(isMatchEndTransition(inMatch, offline)).toBe(true);
  });

  it("does not fire when entering a match", () => {
    expect(isMatchEndTransition(menu, inMatch)).toBe(false);
  });

  it("does not fire with no prior state", () => {
    expect(isMatchEndTransition(null, menu)).toBe(false);
  });

  it("does not fire while still in the match", () => {
    expect(isMatchEndTransition(inMatch, inMatch)).toBe(false);
  });
});
