import { UtilityPracticeService } from "./utility-practice.service";

// The in-game menu changes map through the same changeMap the panel uses, so
// the host-only rule and the lock live in one place. What these pin down is
// the part that is new: the session comes from the calling server, and the
// player is looked up by the steam id the plugin sends.
describe("UtilityPracticeService in-game map change", () => {
  const HOST = "76561100000000001";
  const GUEST = "76561100000000002";

  function makeService(options: { isRender?: boolean } = {}) {
    const postgres = {
      query: jest.fn(async (sql: string, params: Array<unknown>) => {
        if (sql.includes("FROM public.players")) {
          return params[0] === HOST || params[0] === GUEST
            ? [{ name: "someone", role: "user", steam_id: params[0] }]
            : [];
        }

        if (sql.includes("FROM public.maps")) {
          return [{ name: "de_inferno" }, { name: "de_mirage" }];
        }

        return [];
      }),
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
      { getConnection: () => ({}) } as any,
    ) as any;

    jest
      .spyOn(service, "sessionForServer")
      .mockImplementation(async (id) =>
        id === "server-1"
          ? {
              session_id: "session-1",
              match_id: "match-1",
              map_name: "de_mirage",
            }
          : null,
      );
    jest.spyOn(service, "session").mockResolvedValue({
      id: "session-1",
      host_steam_id: HOST,
      is_render: options.isRender ?? false,
    });

    const changeMap = jest
      .spyOn(service, "changeMap")
      .mockResolvedValue({ success: true, map_name: "de_inferno" });

    return { service, changeMap };
  }

  it("lists the practice maps and lets the host change them", async () => {
    const { service } = makeService();

    await expect(service.mapsForServer("server-1", HOST)).resolves.toEqual({
      map_name: "de_mirage",
      can_change: true,
      maps: ["de_inferno", "de_mirage"],
    });
  });

  it("shows a guest the maps but not the change", async () => {
    const { service } = makeService();

    expect((await service.mapsForServer("server-1", GUEST)).can_change).toBe(
      false,
    );
  });

  it("never offers a render server's map", async () => {
    const { service } = makeService({ isRender: true });

    expect((await service.mapsForServer("server-1", HOST)).can_change).toBe(
      false,
    );
  });

  it("has nothing for a server that runs no session", async () => {
    const { service } = makeService();

    await expect(service.mapsForServer("server-2", HOST)).resolves.toBeNull();
  });

  it("changes the calling server's own session, as that player", async () => {
    const { service, changeMap } = makeService();

    await service.changeMapFromServer("server-1", HOST, "de_inferno");

    expect(changeMap).toHaveBeenCalledWith(
      expect.objectContaining({ steam_id: HOST, role: "user" }),
      { session_id: "session-1", map_name: "de_inferno" },
    );
  });

  it("refuses a player the panel does not know", async () => {
    const { service, changeMap } = makeService();

    await expect(
      service.changeMapFromServer(
        "server-1",
        "76561100000000009",
        "de_inferno",
      ),
    ).rejects.toThrow("only the host");
    expect(changeMap).not.toHaveBeenCalled();
  });
});
