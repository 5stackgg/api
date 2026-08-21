import { UtilityPracticeService } from "./utility-practice.service";

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
    };

    const service = new UtilityPracticeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      postgres as any,
      {} as any,
      {} as any,
      matchAssistant as any,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
    ) as any;

    jest.spyOn(service, "isEnabled").mockResolvedValue(true);
    jest.spyOn(service, "resolveMap").mockResolvedValue("de_mirage");
    jest.spyOn(service, "resolveRegion").mockResolvedValue("TestA");
    jest.spyOn(service, "assertServerHeadroom").mockResolvedValue(undefined);
    jest.spyOn(service, "insertSession").mockResolvedValue({ id: "session-1" });
    jest.spyOn(service, "session").mockResolvedValue({ id: "session-1" });

    // Deliberately made to look attractive: if the render path asks for a free
    // server at all, this one is sitting right there and the test fails.
    const freeServer = jest
      .spyOn(service, "freePracticeServer")
      .mockResolvedValue({ id: "someone-elses-server", region: "TestA" });
    const createMatch = jest
      .spyOn(service, "createPracticeMatch")
      .mockResolvedValue("match-1");

    return { service, freeServer, createMatch, postgres, matchAssistant };
  }

  afterEach(() => jest.restoreAllMocks());

  it("never reuses a free practice server", async () => {
    const { service, freeServer } = makeService();

    await service.startForRender({
      mapName: "de_mirage",
      hostSteamId: "76561198000000001",
    });

    expect(freeServer).not.toHaveBeenCalled();
  });

  it("books its own server by leaving serverId null", async () => {
    const { service, createMatch } = makeService();

    await service.startForRender({
      mapName: "de_mirage",
      hostSteamId: "76561198000000001",
    });

    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: null }),
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
        hostSteamId: "76561198000000001",
      }),
    ).rejects.toThrow("no practice servers are free right now");

    expect(headroom).toHaveBeenCalledWith("TestA");
  });
});
