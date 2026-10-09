import { UtilityRendersController } from "./utility-renders.controller";

// The render queue page's view of what the library is missing, and the button
// that queues it. Both are a moderator's: a render books a GPU and a server.
describe("lineup preview coverage actions", () => {
  const MODERATOR = { steam_id: "76561198000000002", role: "moderator" } as any;
  const PLAYER = { steam_id: "76561198000000003", role: "user" } as any;

  function make() {
    const renders = {
      coverage: jest.fn().mockResolvedValue({ version: 2, lineups: [] }),
      enqueueGaps: jest.fn().mockResolvedValue({ queued: 3, skipped: 1 }),
      validateRenderAuth: jest.fn().mockResolvedValue({ id: "job-1" }),
      finalizeUpload: jest.fn().mockResolvedValue({ lineupId: "l", file: "f" }),
    };
    const controller = new UtilityRendersController(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      renders as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, renders };
  }

  it("shows a moderator what one map is missing", async () => {
    const { controller, renders } = make();

    await controller.utilityLineupRenderCoverage({
      user: MODERATOR,
      map_name: "de_mirage",
    });

    expect(renders.coverage).toHaveBeenCalledWith("de_mirage");
  });

  it("treats no map as every map", async () => {
    const { controller, renders } = make();

    await controller.utilityLineupRenderCoverage({ user: MODERATOR });
    await controller.utilityLineupRenderCoverage({
      user: MODERATOR,
      map_name: "",
    });

    expect(renders.coverage.mock.calls).toEqual([[null], [null]]);
  });

  it("is not a player's to read or to queue", async () => {
    const { controller, renders } = make();

    await expect(
      controller.utilityLineupRenderCoverage({ user: PLAYER }),
    ).rejects.toThrow("only a moderator");
    await expect(
      controller.renderUtilityLineupPreviews({ user: PLAYER, scope: "all" }),
    ).rejects.toThrow("only a moderator");
    expect(renders.coverage).not.toHaveBeenCalled();
    expect(renders.enqueueGaps).not.toHaveBeenCalled();
  });

  it("queues the scope asked for, in the moderator's name", async () => {
    const { controller, renders } = make();

    await expect(
      controller.renderUtilityLineupPreviews({
        user: MODERATOR,
        scope: "outdated",
        map_name: "de_inferno",
      }),
    ).resolves.toEqual({ queued: 3, skipped: 1 });

    expect(renders.enqueueGaps).toHaveBeenCalledWith("outdated", {
      mapName: "de_inferno",
      requestedBySteamId: MODERATOR.steam_id,
    });
  });

  it("refuses a scope it does not know rather than guess one", async () => {
    const { controller, renders } = make();

    await expect(
      controller.renderUtilityLineupPreviews({
        user: MODERATOR,
        scope: "everything",
      }),
    ).rejects.toThrow("scope must be");
    expect(renders.enqueueGaps).not.toHaveBeenCalled();
  });

  describe("the version a pod uploads with", () => {
    const upload = async (headers: Record<string, unknown>) => {
      const { controller, renders } = make();
      const response: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        end: jest.fn().mockReturnThis(),
      };

      await controller.upload(
        "job-1",
        { headers: { "x-origin-auth": "job-1:token", ...headers } } as any,
        response,
      );

      return renders.finalizeUpload.mock.calls[0][3];
    };

    it("is taken from the pod's header", async () => {
      expect(await upload({ "x-render-version": "2" })).toBe(2);
    });

    // Recorded as unversioned, which the queue page reads as outdated.
    it("is nothing when the pod sent none, or sent rubbish", async () => {
      expect(await upload({})).toBeNull();
      expect(await upload({ "x-render-version": "latest" })).toBeNull();
      expect(await upload({ "x-render-version": "-1" })).toBeNull();
      expect(await upload({ "x-render-version": "2.5" })).toBeNull();
    });
  });
});
