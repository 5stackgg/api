import { UtilityPracticeService } from "./utility-practice.service";
import { NoPracticeServerHere } from "./errors/NoPracticeServerHere";

const UNSUPPORTED_BUILD =
  "practice servers need the SwiftlyS2 plugin, which does not support this CS2 build yet";

// A render pod is not a guest. It teleports itself around, throws grenades, and
// re-presses jointeam until it spawns -- so putting it on a server other people
// are already using respawns them and drops smokes under their feet. An idle
// practice server is not an empty one, and nothing in the schema can tell the
// difference, so the rule is simply that a render never reuses one.
describe("UtilityPracticeService.startForRender", () => {
  function makeService() {
    const postgres = { query: jest.fn().mockResolvedValue([]) };
    const matchAssistant = {
      updateMatchStatus: jest.fn().mockResolvedValue(undefined),
      sendUtilityPracticeRefresh: jest.fn().mockResolvedValue(undefined),
      practiceNodeIds: jest.fn().mockResolvedValue(["node-1"]),
      hasOnDemandNodes: jest.fn().mockResolvedValue(true),
    };
    const cache = {
      acquireLock: jest.fn().mockResolvedValue("token"),
      releaseLock: jest.fn().mockResolvedValue(true),
      forget: jest.fn().mockResolvedValue(undefined),
    };

    const service = new UtilityPracticeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      postgres as any,
      {} as any,
      cache as any,
      matchAssistant as any,
      {} as any,
      {} as any,
      {} as any,
      { ensureMode: jest.fn().mockResolvedValue(null) } as any,
      { get: jest.fn() } as any,
      { getConnection: () => ({ publish: jest.fn() }) } as any,
    ) as any;

    jest.spyOn(service, "isEnabled").mockResolvedValue(true);
    jest.spyOn(service, "resolveMap").mockResolvedValue("de_mirage");
    jest.spyOn(service, "resolveRegion").mockResolvedValue("TestA");
    const headroom = jest
      .spyOn(service, "assertServerHeadroom")
      .mockResolvedValue(undefined);
    const insertSession = jest
      .spyOn(service, "insertSession")
      .mockResolvedValue({ id: "session-1" });
    jest.spyOn(service, "session").mockResolvedValue({ id: "session-1" });

    // Deliberately made to look attractive: if the render path asks for a free
    // server at all, this one is sitting right there and the test fails.
    const freeServer = jest
      .spyOn(service, "freePracticeServer")
      .mockResolvedValue({ id: "someone-elses-server", region: "TestA" });
    const createMatch = jest
      .spyOn(service, "createPracticeMatch")
      .mockResolvedValue("match-1");

    return {
      service,
      freeServer,
      createMatch,
      insertSession,
      headroom,
      postgres,
      matchAssistant,
    };
  }

  afterEach(() => jest.restoreAllMocks());

  it("never reuses a free practice server", async () => {
    const { service, freeServer } = makeService();

    await service.startForRender({
      mapName: "de_mirage",
      requestedBySteamId: "76561198000000001",
    });

    expect(freeServer).not.toHaveBeenCalled();
  });

  it("books its own server by leaving serverId null", async () => {
    const { service, createMatch } = makeService();

    await service.startForRender({
      mapName: "de_mirage",
      requestedBySteamId: "76561198000000001",
    });

    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: null }),
    );
  });

  it("creates a system-owned session with no host, requester only the organizer", async () => {
    const { service, insertSession, createMatch } = makeService();

    await service.startForRender({
      mapName: "de_mirage",
      requestedBySteamId: "76561198000000001",
    });

    // The session itself is host-less -- that is what stops it reading as the
    // requester's own practice server.
    expect(insertSession).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ isRender: true }),
    );
    // The requester survives only as the match organizer (a NOT NULL column)
    // and the render is flagged so no human is seated in its lineup.
    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        organizerSteamId: "76561198000000001",
        isRender: true,
      }),
    );
  });

  // Booking its own server still spends one, so the reserve a player's session
  // respects has to hold here too -- a preview clip is not worth the last slot.
  it("still respects the free-server reserve", async () => {
    const { service } = makeService();
    const headroom = jest
      .spyOn(service, "assertServerHeadroom")
      .mockRejectedValue(new Error("no practice servers are free right now"));
    jest.spyOn(service, "fail").mockResolvedValue(undefined);

    await expect(
      service.startForRender({
        mapName: "de_mirage",
        requestedBySteamId: "76561198000000001",
      }),
    ).rejects.toThrow("no practice servers are free right now");

    expect(headroom).toHaveBeenCalledWith("TestA");
  });

  // Practice runs SwiftlyS2 whatever matches run, so an install that moved its
  // matches to CounterStrikeSharp after a CS2 update still cannot boot one.
  it("books nothing while SwiftlyS2 does not support the CS2 build", async () => {
    const { service, matchAssistant, insertSession, createMatch } =
      makeService();
    matchAssistant.practiceNodeIds.mockResolvedValue([]);

    const booking = service.startForRender({
      mapName: "de_mirage",
      requestedBySteamId: "76561198000000001",
    });

    await expect(booking).rejects.toBeInstanceOf(NoPracticeServerHere);
    await expect(booking).rejects.toThrow(UNSUPPORTED_BUILD);
    expect(matchAssistant.practiceNodeIds).toHaveBeenCalledWith("TestA");
    expect(insertSession).not.toHaveBeenCalled();
    expect(createMatch).not.toHaveBeenCalled();
  });

  it("leaves a region with no node at all to the headroom check", async () => {
    const { service, matchAssistant, headroom } = makeService();
    matchAssistant.practiceNodeIds.mockResolvedValue([]);
    matchAssistant.hasOnDemandNodes.mockResolvedValue(false);
    headroom.mockRejectedValue(
      new NoPracticeServerHere("no practice server can be started in TestA"),
    );
    jest.spyOn(service, "fail").mockResolvedValue(undefined);

    await expect(
      service.startForRender({
        mapName: "de_mirage",
        requestedBySteamId: "76561198000000001",
      }),
    ).rejects.toThrow("no practice server can be started in TestA");
  });
});

// Not a wait anyone else's server would end, so it never joins the queue that
// caps whoever is holding one.
describe("UtilityPracticeService.start on an unsupported CS2 build", () => {
  afterEach(() => jest.restoreAllMocks());

  it("turns the player away without queuing them", async () => {
    const matchAssistant = {
      practiceNodeIds: jest.fn().mockResolvedValue([]),
      hasOnDemandNodes: jest.fn().mockResolvedValue(true),
    };
    const service = new UtilityPracticeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      {
        acquireLock: jest.fn().mockResolvedValue("token"),
        releaseLock: jest.fn().mockResolvedValue(true),
        forget: jest.fn().mockResolvedValue(undefined),
      } as any,
      matchAssistant as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
      { getConnection: () => ({ publish: jest.fn() }) } as any,
    ) as any;

    jest.spyOn(service, "isEnabled").mockResolvedValue(true);
    jest.spyOn(service, "assertRole").mockResolvedValue(undefined);
    jest.spyOn(service, "assertNotBusy").mockResolvedValue(undefined);
    jest.spyOn(service, "resolveMap").mockResolvedValue("de_mirage");
    jest.spyOn(service, "resolveRegion").mockResolvedValue("TestA");
    const insertSession = jest.spyOn(service, "insertSession");
    const joinWaitlist = jest
      .spyOn(service, "joinWaitlist")
      .mockResolvedValue(undefined);

    await expect(
      service.start(
        { steam_id: "76561198000000001" },
        { map_name: "de_mirage", region: "TestA" },
      ),
    ).rejects.toThrow(UNSUPPORTED_BUILD);

    expect(matchAssistant.practiceNodeIds).toHaveBeenCalledWith("TestA");
    expect(joinWaitlist).not.toHaveBeenCalled();
    expect(insertSession).not.toHaveBeenCalled();
  });
});

describe("UtilityPracticeService.renderConnection", () => {
  it("names SwiftlyS2 whatever runtime the node runs matches on", async () => {
    const postgres = {
      query: jest.fn().mockResolvedValue([
        {
          match_id: "match-1",
          password: "secret",
          port: 27015,
          node_id: "node-1",
        },
      ]),
    };
    const service = new UtilityPracticeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      postgres as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
      { getConnection: () => ({ publish: jest.fn() }) } as any,
    );

    await expect(service.renderConnection("session-1")).resolves.toEqual({
      addr: "127.0.0.1:27015",
      password: "secret",
      match_id: "match-1",
      plugin_runtime: "swiftlys2",
      node_id: "node-1",
    });
    expect(postgres.query.mock.calls[0][0]).not.toContain(
      "active_plugin_runtime",
    );
  });
});
