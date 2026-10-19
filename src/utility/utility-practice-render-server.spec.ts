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
    // The region lookup answers with the region it was asked to prefer, or
    // "Fallback" when it was given none -- every region has servers here.
    const postgres = {
      query: jest.fn(async (sql: string, params?: Array<unknown>) =>
        sql.includes("total_region_server_count")
          ? [{ value: params?.[0] ?? "Fallback" }]
          : [],
      ),
    };
    const matchAssistant = {
      updateMatchStatus: jest.fn().mockResolvedValue(undefined),
      sendUtilityPracticeRefresh: jest.fn().mockResolvedValue(undefined),
      practiceNodeIds: jest.fn().mockResolvedValue(["node-1"]),
      hasOnDemandNodes: jest.fn().mockResolvedValue(true),
      renderNodes: jest
        .fn()
        .mockResolvedValue([
          { id: "node-1", region: "TestA", gpu_only: false, supported: true },
        ]),
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
    // The region with the most free servers, which is not where any GPU is.
    jest.spyOn(service, "resolveRegion").mockResolvedValue("Busiest");
    const headroom = jest
      .spyOn(service, "hasServerHeadroom")
      .mockResolvedValue(true);
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

  const render = (service: any) =>
    service.startForRender({
      mapName: "de_mirage",
      requestedBySteamId: "76561198000000001",
    });

  // The pod films its server over the loopback they share, so the server has
  // to boot on the GPU's node. Booking into the region with the most free
  // servers put it wherever that was -- LAN regions never counted -- and the
  // booking found no GPU there, failing the renders the moment they started.
  it("books into the region of the GPU that will film it, a LAN one included", async () => {
    const { service, matchAssistant, createMatch, insertSession, postgres } =
      makeService();
    matchAssistant.renderNodes.mockResolvedValue([
      { id: "lan-gpu", region: "Lan", gpu_only: false, supported: true },
    ]);

    await render(service);

    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({ region: "Lan" }),
    );
    expect(insertSession).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ region: "Lan" }),
    );
    expect(service.resolveRegion).not.toHaveBeenCalled();
    expect(
      postgres.query.mock.calls.find(([sql]: [string]) =>
        sql.includes("total_region_server_count"),
      )?.[1],
    ).toEqual(["Lan"]);
  });

  // A GPU-only node takes no matches, so its slot is not one a match could
  // have had. The region is only one the match's triggers accept.
  it("books a GPU-only node without spending the free-server reserve", async () => {
    const { service, matchAssistant, createMatch, headroom } = makeService();
    matchAssistant.renderNodes.mockResolvedValue([
      { id: "gpu-only", region: null, gpu_only: true, supported: true },
    ]);
    headroom.mockResolvedValue(false);

    await render(service);

    expect(headroom).not.toHaveBeenCalled();
    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({ region: "Fallback" }),
    );
  });

  // Booking its own server on a node that takes matches still spends one of
  // them, so the reserve a player's session respects has to hold here too --
  // a preview clip is not worth the last slot.
  it("still respects the free-server reserve on a node that takes matches", async () => {
    const { service, headroom, createMatch } = makeService();
    headroom.mockResolvedValue(false);

    await expect(render(service)).rejects.toThrow(
      "no practice servers are free right now",
    );

    expect(headroom).toHaveBeenCalledWith("TestA");
    expect(createMatch).not.toHaveBeenCalled();
  });

  it("passes over a node whose region is at its reserve for one that is not", async () => {
    const { service, matchAssistant, headroom, createMatch } = makeService();
    matchAssistant.renderNodes.mockResolvedValue([
      { id: "full", region: "Full", gpu_only: false, supported: true },
      { id: "roomy", region: "Roomy", gpu_only: false, supported: true },
    ]);
    headroom.mockImplementation(async (region: string) => region === "Roomy");

    await render(service);

    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({ region: "Roomy" }),
    );
  });

  it("waits while no GPU free to render on has a server free", async () => {
    const { service, matchAssistant, createMatch } = makeService();
    matchAssistant.renderNodes.mockResolvedValue([]);

    await expect(render(service)).rejects.toThrow(
      "no practice servers are free right now",
    );
    expect(createMatch).not.toHaveBeenCalled();
  });

  // Practice runs SwiftlyS2 whatever matches run, so an install that moved its
  // matches to CounterStrikeSharp after a CS2 update still cannot boot one.
  it("books nothing while SwiftlyS2 does not support the CS2 build", async () => {
    const { service, matchAssistant, insertSession, createMatch } =
      makeService();
    matchAssistant.renderNodes.mockResolvedValue([
      { id: "node-1", region: "TestA", gpu_only: false, supported: false },
    ]);

    const booking = render(service);

    await expect(booking).rejects.toBeInstanceOf(NoPracticeServerHere);
    await expect(booking).rejects.toThrow(UNSUPPORTED_BUILD);
    expect(insertSession).not.toHaveBeenCalled();
    expect(createMatch).not.toHaveBeenCalled();
  });

  // Nothing films a discovery, so it needs no GPU and books by region as a
  // player's session does.
  it("books a discovery by region, within the reserve", async () => {
    const { service, matchAssistant, createMatch, headroom } = makeService();

    await service.startForRender({
      mapName: "de_mirage",
      requestedBySteamId: "76561198000000001",
      isDiscovery: true,
    });

    expect(matchAssistant.renderNodes).not.toHaveBeenCalled();
    expect(matchAssistant.practiceNodeIds).toHaveBeenCalledWith("Busiest");
    expect(headroom).toHaveBeenCalledWith("Busiest");
    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({ region: "Busiest" }),
    );
  });

  it("leaves a discovery with no node in its region to the headroom check", async () => {
    const { service, matchAssistant, headroom } = makeService();
    matchAssistant.practiceNodeIds.mockResolvedValue([]);
    matchAssistant.hasOnDemandNodes.mockResolvedValue(false);
    headroom.mockResolvedValue(false);
    jest.spyOn(service, "fail").mockResolvedValue(undefined);

    await expect(
      service.startForRender({
        mapName: "de_mirage",
        requestedBySteamId: "76561198000000001",
        isDiscovery: true,
      }),
    ).rejects.toThrow("no practice server can be started in Busiest");
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
