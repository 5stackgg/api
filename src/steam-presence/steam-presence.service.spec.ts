import { SteamPresenceService } from "./steam-presence.service";

const STEAM_ID = "76561197960500905";
const MATCH_END_JOB = `poll-steam-match-history.match-end.${STEAM_ID}`;

const inMatch = (mode: string) => ({
  gameid: 730,
  richPresence: {
    "game:state": "game",
    "game:mode": mode,
    "game:map": "de_mirage",
  },
});

const MENU = {
  gameid: 730,
  richPresence: { steam_display: "#display_Menu" },
};

const build = (
  options: { onFiveStack?: boolean; lookupFails?: boolean } = {},
) => {
  const store = new Map<string, unknown>();
  const cache = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    put: jest.fn(async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    }),
  };
  const postgres = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("server_player_sessions")) {
        if (options.lookupFails) {
          throw new Error("connection terminated");
        }
        return options.onFiveStack ? [{ found: 1 }] : [];
      }
      return [];
    }),
  };
  const pollQueue = {
    add: jest.fn(async (): Promise<void> => undefined),
    remove: jest.fn(async (): Promise<number> => 1),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new SteamPresenceService(
    logger as never,
    { get: jest.fn(() => ({})) } as never,
    cache as never,
    postgres as never,
    {} as never,
    {} as never,
    pollQueue as never,
  );

  const finishMatch = async (mode = "premier") => {
    await service["handlePresenceState"](STEAM_ID, inMatch(mode));
    await service["handlePresenceState"](STEAM_ID, MENU);
  };

  return { pollQueue, postgres, finishMatch };
};

describe("SteamPresenceService match-end trigger", () => {
  it("queues a match-end poll a minute after a Valve match ends", async () => {
    const { pollQueue, finishMatch } = build();

    await finishMatch();

    expect(pollQueue.add).toHaveBeenCalledTimes(1);
    expect(pollQueue.add).toHaveBeenCalledWith(
      "PollSteamMatchHistoryForUser",
      { steamId: STEAM_ID, matchEnd: true },
      expect.objectContaining({ jobId: MATCH_END_JOB, delay: 60_000 }),
    );
  });

  it("does not poll when the player was just on a 5stack match or server", async () => {
    const { pollQueue, postgres, finishMatch } = build({ onFiveStack: true });

    await finishMatch();

    const lookup = postgres.query.mock.calls.find(([sql]) =>
      sql.includes("server_player_sessions"),
    );
    expect(lookup?.[0]).toContain("m.source = '5stack'");
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it("still polls when the 5stack lookup fails", async () => {
    const { pollQueue, finishMatch } = build({ lookupFails: true });

    await finishMatch();

    expect(pollQueue.add).toHaveBeenCalledTimes(1);
  });

  it("lets a later match end replace the poll still waiting from an earlier flap", async () => {
    const { pollQueue, finishMatch } = build();

    await finishMatch();
    await finishMatch();

    expect(pollQueue.remove).toHaveBeenCalledTimes(2);
    expect(pollQueue.remove).toHaveBeenLastCalledWith(MATCH_END_JOB);
    expect(pollQueue.remove.mock.invocationCallOrder[1]).toBeLessThan(
      pollQueue.add.mock.invocationCallOrder[1],
    );
  });

  it("caps a flapping player at six match-end polls an hour", async () => {
    const { pollQueue, finishMatch } = build();

    for (let i = 0; i < 8; i++) {
      await finishMatch();
    }

    expect(pollQueue.add).toHaveBeenCalledTimes(6);
  });

  it("does not poll when a deathmatch ends", async () => {
    const { pollQueue, finishMatch } = build();

    await finishMatch("deathmatch");

    expect(pollQueue.add).not.toHaveBeenCalled();
  });
});
