import { UtilityPracticeService } from "./utility-practice.service";

// The practice plugin posts a full roster the tick after anybody connects or
// disconnects. What the website is waiting on is not the roster but the flip --
// so the push has to reach exactly the players whose presence changed, and
// nobody else. A reconciling post that finds nothing changed must be silent, or
// every idle server would wake every tab on it once a minute.
describe("UtilityPracticeService.reportOccupancy", () => {
  function makeService(flipped: Array<{ steam_id: string }>) {
    const publish = jest.fn().mockResolvedValue(undefined);
    const postgres = { query: jest.fn() };

    // The UPDATE ... RETURNING is the first query; the two session bookkeeping
    // writes that follow it only run when somebody is present.
    postgres.query
      .mockResolvedValueOnce(flipped)
      .mockResolvedValue([] as Array<unknown>);

    const load = {
      whereAmI: jest.fn(async () => ({
        on_server: true,
        map_name: "de_mirage" as string | null,
        session_id: "session-1" as string | null,
        switching: false,
      })),
    };

    const service = new UtilityPracticeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      postgres as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      load as any,
      { ensureMode: jest.fn().mockResolvedValue(null) } as any,
      { get: jest.fn() } as any,
      { getConnection: () => ({ publish }) } as any,
    ) as any;

    jest.spyOn(service, "liveSessionForServer").mockResolvedValue({
      session_id: "session-1",
      match_id: "match-1",
      map_name: "de_mirage",
      password: "hunter2",
    });
    jest.spyOn(service, "touch").mockResolvedValue(undefined);

    return { service, publish, postgres, load };
  }

  function pushed(publish: jest.Mock) {
    return publish.mock.calls.map(([channel, body]) => ({
      channel,
      ...JSON.parse(body as string),
    }));
  }

  it("pushes utility:where to only the players whose presence flipped", async () => {
    const { service, publish } = makeService([{ steam_id: "76561100000000001" }]);

    await service.reportOccupancy("server-1", [
      "76561100000000001",
      "76561100000000002",
    ]);

    const messages = pushed(publish);

    expect(messages).toHaveLength(1);
    expect(messages[0].channel).toBe("send-message-to-steam-id");
    expect(messages[0].steamId).toBe("76561100000000001");
    expect(messages[0].event).toBe("utility:where");
    expect(messages[0].data.on_server).toBe(true);
  });

  it("says nothing when a reconciling report finds no change", async () => {
    const { service, publish } = makeService([]);

    await service.reportOccupancy("server-1", ["76561100000000001"]);

    expect(publish).not.toHaveBeenCalled();
  });

  it("pushes for a player who left, not only for one who arrived", async () => {
    const { service, publish, load } = makeService([
      { steam_id: "76561100000000009" },
    ]);

    // Nobody is on the server any more, so the location lookup comes back empty
    // and the player is told they are off it.
    load.whereAmI.mockResolvedValue({
      on_server: false,
      map_name: null,
      session_id: null,
      switching: false,
    });

    await service.reportOccupancy("server-1", []);

    const messages = pushed(publish);

    expect(messages).toHaveLength(1);
    expect(messages[0].steamId).toBe("76561100000000009");
    expect(messages[0].data.on_server).toBe(false);
  });

  it("ignores a steam id the plugin sent in a shape we did not ask for", async () => {
    const { service, postgres } = makeService([]);

    await service.reportOccupancy("server-1", [
      "76561100000000001",
      "not-a-steam-id",
      "",
    ]);

    const [, params] = postgres.query.mock.calls[0];

    expect(params[1]).toEqual(["76561100000000001"]);
  });

  it("does not fail the occupancy write when a push cannot be delivered", async () => {
    const { service, publish } = makeService([{ steam_id: "76561100000000001" }]);

    publish.mockRejectedValue(new Error("redis is down"));

    await expect(
      service.reportOccupancy("server-1", ["76561100000000001"]),
    ).resolves.toBeUndefined();
  });
});
