import { DemosController } from "./demos.controller";

// "Match Stats Ready" goes out from the game server's upload, once the parse it
// started has written the stats. It used to hang off a route nothing called.
describe("DemosController.markDemoAsUploaded", () => {
  const MATCH = "11111111-1111-1111-1111-111111111111";
  const MAP = "22222222-2222-2222-2222-222222222222";

  function make({
    parsed = true,
    ready = true,
  }: { parsed?: boolean; ready?: boolean } = {}) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO public.match_map_demos")) {
        return [{ id: "demo-1" }];
      }
      if (sql.includes("AS ready")) {
        return ready ? [{ ready: true }] : [];
      }
      if (sql.includes("match_lineup_players")) {
        return [
          { steam_id: "76561198000000001" },
          { steam_id: "76561198000000002" },
        ];
      }
      return [];
    });
    const demoMetadata = {
      ensureParsedById: jest.fn().mockResolvedValue(parsed),
    };
    const notifications = {
      mapPosterImage: jest.fn().mockResolvedValue("poster.webp"),
      notifyPlayers: jest.fn().mockResolvedValue(2),
    };
    const controller = new DemosController(
      {} as any,
      {} as any,
      { query } as any,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      demoMetadata as any,
      notifications as any,
    );
    return { controller, query, demoMetadata, notifications };
  }

  async function upload(controller: DemosController) {
    const response = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
      json: jest.fn(),
    };
    await controller.markDemoAsUploaded(
      {
        params: { matchId: MATCH },
        body: { mapId: MAP, demo: "1-de_inferno.dem", size: 1024 },
      } as any,
      response as any,
    );
    // The parse and the notification run after the response is sent.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
  }

  it("tells everyone who played once the upload's parse lands", async () => {
    const { controller, demoMetadata, notifications } = make();

    const response = await upload(controller);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(demoMetadata.ensureParsedById).toHaveBeenCalledWith("demo-1");
    expect(notifications.notifyPlayers).toHaveBeenCalledTimes(1);
    expect(notifications.notifyPlayers).toHaveBeenCalledWith(
      "MatchStatsReady",
      expect.objectContaining({
        entity_id: MATCH,
        steamIds: ["76561198000000001", "76561198000000002"],
        data: { image: "poster.webp" },
      }),
    );
  });

  // Already parsed, parsed by someone else, or the parse failed: none of them
  // is the moment the stats arrived.
  it("stays quiet when the upload did not parse the demo itself", async () => {
    const { controller, query, notifications } = make({ parsed: false });

    await upload(controller);

    expect(query.mock.calls.some(([sql]) => sql.includes("AS ready"))).toBe(
      false,
    );
    expect(notifications.notifyPlayers).not.toHaveBeenCalled();
  });

  // A map still to play, a demo still parsing, or a notification already sent.
  it("stays quiet until the match is over and none was sent yet", async () => {
    const { controller, notifications } = make({ ready: false });

    await upload(controller);

    expect(notifications.notifyPlayers).not.toHaveBeenCalled();
  });
});
