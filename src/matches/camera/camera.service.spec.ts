import { Logger } from "@nestjs/common";
import { CameraService } from "./camera.service";
import { User } from "../../auth/types/User";

// Authorization only. Nobody playing the match may watch any of it, a
// competitor never sees the other side, and every steam id that reaches a
// MediaMTX path is a Steam64.
describe("CameraService authorization", () => {
  const MATCH_ID = "11111111-1111-1111-1111-111111111111";
  const MY_LINEUP = "22222222-2222-2222-2222-222222222222";
  const TEAMMATE = "76561198000000002";

  const organizer = { steam_id: "76561198000000009", role: "user" } as User;
  const admin = { steam_id: "76561198000000008", role: "administrator" } as User;
  const player = { steam_id: "76561198000000001", role: "user" } as User;

  let postgres: { query: jest.Mock };
  let mediaMtx: { proxySdp: jest.Mock; isPathReady: jest.Mock; kickSessions: jest.Mock };
  let matchAssistant: { isOrganizer: jest.Mock };
  let gameStreamer: { validateStatusOriginAuth: jest.Mock };
  let service: CameraService;

  const scopeRow = (myLineupId: string | null, allowTeammates: boolean) => [
    { my_lineup_id: myLineupId, allow_teammates: allowTeammates },
  ];

  beforeEach(() => {
    postgres = { query: jest.fn() };
    mediaMtx = {
      proxySdp: jest.fn().mockResolvedValue("answer"),
      isPathReady: jest.fn().mockResolvedValue(true),
      kickSessions: jest.fn().mockResolvedValue(undefined),
    };
    matchAssistant = { isOrganizer: jest.fn().mockResolvedValue(false) };
    gameStreamer = {
      validateStatusOriginAuth: jest.fn().mockResolvedValue(true),
    };

    service = new CameraService(
      new Logger("CameraAuthTest"),
      {} as any,
      postgres as any,
      mediaMtx as any,
      matchAssistant as any,
      gameStreamer as any,
    );
  });

  it("gives an organizer who is not playing both lineups", async () => {
    postgres.query.mockResolvedValue(scopeRow(null, false));
    matchAssistant.isOrganizer.mockResolvedValue(true);

    await expect(service.watchScope(MATCH_ID, organizer)).resolves.toEqual({
      kind: "all",
    });
  });

  it("gives an administrator who is not playing both lineups", async () => {
    postgres.query.mockResolvedValue(scopeRow(null, false));

    await expect(service.watchScope(MATCH_ID, admin)).resolves.toEqual({
      kind: "all",
    });
  });

  // The whole point of the feature: a live view of the other side is exactly
  // the advantage it exists to prevent.
  it("refuses an organizer who is rostered in the match", async () => {
    postgres.query.mockResolvedValue(scopeRow(MY_LINEUP, false));
    matchAssistant.isOrganizer.mockResolvedValue(true);

    await expect(service.watchScope(MATCH_ID, organizer)).rejects.toThrow(
      /not authorized/i,
    );
  });

  // Deliberate exception so the feature can be exercised end-to-end without a
  // second account; organizers playing stay scoped to their own side.
  it("still gives a rostered administrator both lineups", async () => {
    postgres.query.mockResolvedValue(scopeRow(MY_LINEUP, false));

    await expect(service.watchScope(MATCH_ID, admin)).resolves.toEqual({
      kind: "all",
    });
  });

  it("refuses a player when teammate viewing is off", async () => {
    postgres.query.mockResolvedValue(scopeRow(MY_LINEUP, false));

    await expect(service.watchScope(MATCH_ID, player)).rejects.toThrow(
      /not authorized/i,
    );
  });

  it("scopes a player to their own lineup when teammate viewing is on", async () => {
    postgres.query.mockResolvedValue(scopeRow(MY_LINEUP, true));

    await expect(service.watchScope(MATCH_ID, player)).resolves.toEqual({
      kind: "lineup",
      lineupId: MY_LINEUP,
    });
  });

  it("refuses a spectator with no role and no roster spot", async () => {
    postgres.query.mockResolvedValue(scopeRow(null, true));

    await expect(service.watchScope(MATCH_ID, player)).rejects.toThrow(
      /not authorized/i,
    );
  });

  it("lets a teammate watch someone on their own lineup", async () => {
    postgres.query
      .mockResolvedValueOnce(scopeRow(MY_LINEUP, true))
      .mockResolvedValueOnce([{ exists: true }]);

    await service.proxyAdminWatch(MATCH_ID, TEAMMATE, player, "offer");

    expect(mediaMtx.proxySdp).toHaveBeenCalledWith(
      `camera-${MATCH_ID}-${TEAMMATE}`,
      "whep",
      "offer",
    );
  });

  it("refuses a teammate watching someone on the other lineup", async () => {
    postgres.query
      .mockResolvedValueOnce(scopeRow(MY_LINEUP, true))
      .mockResolvedValueOnce([]);

    await expect(
      service.proxyAdminWatch(MATCH_ID, TEAMMATE, player, "offer"),
    ).rejects.toThrow(/not authorized/i);
    expect(mediaMtx.proxySdp).not.toHaveBeenCalled();
  });

  // `..` segments in a steam id resolve away the path prefix and reach a
  // different camera entirely once the URL is parsed.
  it.each([
    "../../camera-other-76561198000000003",
    "76561198000000001/../..",
    "not-a-steam-id",
    "",
  ])("refuses a steam id that is not a Steam64: %s", async (steamId) => {
    postgres.query.mockResolvedValue(scopeRow(null, false));
    matchAssistant.isOrganizer.mockResolvedValue(true);

    await expect(
      service.proxyAdminWatch(MATCH_ID, steamId, organizer, "offer"),
    ).rejects.toThrow(/not authorized/i);
    expect(mediaMtx.proxySdp).not.toHaveBeenCalled();
  });

  it("refuses a match id that is not a uuid, even for an administrator", async () => {
    await expect(
      service.watchScope("../../etc/passwd", admin),
    ).rejects.toThrow(/not authorized/i);
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("refuses a match that does not exist", async () => {
    postgres.query.mockResolvedValue([]);

    await expect(service.watchScope(MATCH_ID, admin)).rejects.toThrow(
      /not authorized/i,
    );
  });

  // The broadcast pod has no session; it authenticates as the match itself.
  describe("broadcast overlay", () => {
    const AUTH = "match-1:secret";

    it("proxies a rostered player's camera", async () => {
      postgres.query.mockResolvedValue([{ exists: true }]);

      await service.proxyBroadcastWatch(MATCH_ID, TEAMMATE, AUTH, "offer");

      expect(mediaMtx.proxySdp).toHaveBeenCalledWith(
        `camera-${MATCH_ID}-${TEAMMATE}`,
        "whep",
        "offer",
      );
    });

    it("refuses a bad origin auth", async () => {
      gameStreamer.validateStatusOriginAuth.mockResolvedValue(false);

      await expect(
        service.proxyBroadcastWatch(MATCH_ID, TEAMMATE, "nope", "offer"),
      ).rejects.toThrow(/not authorized/i);
      expect(mediaMtx.proxySdp).not.toHaveBeenCalled();
    });

    // One pod is authorized for one match: it must not be able to name a
    // player from a different one.
    it("refuses a player who is not on this match", async () => {
      postgres.query.mockResolvedValue([]);

      await expect(
        service.proxyBroadcastWatch(MATCH_ID, TEAMMATE, AUTH, "offer"),
      ).rejects.toThrow(/not authorized/i);
    });

    it("refuses a steam id that is not a Steam64", async () => {
      await expect(
        service.proxyBroadcastWatch(MATCH_ID, "../../x", AUTH, "offer"),
      ).rejects.toThrow(/not authorized/i);
      expect(gameStreamer.validateStatusOriginAuth).not.toHaveBeenCalled();
    });
  });
});
