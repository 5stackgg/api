import { Logger } from "@nestjs/common";
import { VoiceService } from "./voice.service";
import { User } from "../auth/types/User";

describe("VoiceService", () => {
  const LOBBY_ID = "11111111-1111-1111-1111-111111111111";
  const ME = { steam_id: "76561198000000001" } as User;
  const PEER = "76561198000000002";

  let postgres: { query: jest.Mock };
  let mediaMtx: { proxySdp: jest.Mock; kickSessions: jest.Mock; listPaths: jest.Mock };
  let service: VoiceService;

  // The service reads the enabled flag and then the membership row, so the
  // happy path needs both in order.
  const enabled = (value: boolean) => [{ value: String(value) }];
  // Voice is on unless explicitly disabled, so "no row" is enabled.

  const accepted = () =>
    postgres.query
      .mockResolvedValueOnce(enabled(true))
      .mockResolvedValueOnce([{ status: "Accepted" }]);

  beforeEach(() => {
    postgres = { query: jest.fn().mockResolvedValue([]) };
    mediaMtx = {
      proxySdp: jest.fn().mockResolvedValue("answer-sdp"),
      kickSessions: jest.fn().mockResolvedValue(undefined),
      listPaths: jest.fn().mockResolvedValue(new Map()),
    };
    service = new VoiceService(
      new Logger("VoiceTest"),
      postgres as any,
      mediaMtx as any,
    );
  });

  it("publishes to the member's own path", async () => {
    accepted();

    await expect(service.publish(LOBBY_ID, ME, "offer")).resolves.toBe(
      "answer-sdp",
    );
    expect(mediaMtx.proxySdp).toHaveBeenCalledWith(
      `voice-${LOBBY_ID}-${ME.steam_id}`,
      "whip",
      "offer",
    );
  });

  it("refuses anyone who is not in the lobby", async () => {
    postgres.query
      .mockResolvedValueOnce(enabled(true))
      .mockResolvedValueOnce([]);

    await expect(service.publish(LOBBY_ID, ME, "offer")).rejects.toThrow(
      /not a member/i,
    );
    expect(mediaMtx.proxySdp).not.toHaveBeenCalled();
  });

  // An invite that has not been taken up is not a seat at the table.
  it("refuses a member who has not accepted", async () => {
    postgres.query
      .mockResolvedValueOnce(enabled(true))
      .mockResolvedValueOnce([{ status: "Invited" }]);

    await expect(service.publish(LOBBY_ID, ME, "offer")).rejects.toThrow(
      /not a member/i,
    );
  });

  it("is enabled when no setting row exists", async () => {
    postgres.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: "Accepted" }]);

    await expect(service.publish(LOBBY_ID, ME, "offer")).resolves.toBe(
      "answer-sdp",
    );
  });

  it("refuses everything while the feature is off", async () => {
    postgres.query.mockResolvedValue(enabled(false));

    await expect(service.publish(LOBBY_ID, ME, "offer")).rejects.toThrow(
      /not enabled/i,
    );
    expect(mediaMtx.proxySdp).not.toHaveBeenCalled();
  });

  // Guards the lobby id before it reaches Postgres as a uuid.
  it("refuses a lobby id that is not a uuid", async () => {
    postgres.query.mockResolvedValue(enabled(true));

    await expect(
      service.publish("../../etc/passwd", ME, "offer"),
    ).rejects.toThrow(/not a member/i);
    // The membership lookup never runs: the id is rejected before it could
    // reach Postgres as a uuid.
    expect(postgres.query).toHaveBeenCalledTimes(1);
  });

  it("subscribes to a peer's path", async () => {
    accepted();

    await service.subscribe(LOBBY_ID, PEER, ME, "offer");

    expect(mediaMtx.proxySdp).toHaveBeenCalledWith(
      `voice-${LOBBY_ID}-${PEER}`,
      "whep",
      "offer",
    );
  });

  // Subscribing to yourself is an echo loop, never something a client wants.
  it("refuses subscribing to your own microphone", async () => {
    accepted();

    await expect(
      service.subscribe(LOBBY_ID, ME.steam_id, ME, "offer"),
    ).rejects.toThrow(/your own/i);
  });

  it("lists the whole party and flags who has a live mic", async () => {
    postgres.query
      .mockResolvedValueOnce(enabled(true))
      .mockResolvedValueOnce([{ status: "Accepted" }])
      .mockResolvedValueOnce([
        { steam_id: ME.steam_id, name: "me", avatar_url: null },
        { steam_id: PEER, name: "peer", avatar_url: null },
      ]);
    mediaMtx.listPaths.mockResolvedValue(
      new Map([
        [`voice-${LOBBY_ID}-${PEER}`, { ready: true, bytesReceived: 10 }],
      ]),
    );

    const participants = await service.participants(LOBBY_ID, ME);

    expect(participants).toEqual([
      { steamId: ME.steam_id, name: "me", avatarUrl: null, speaking: false },
      { steamId: PEER, name: "peer", avatarUrl: null, speaking: true },
    ]);
  });

  // Losing MediaMTX should dim the talking indicators, not empty the party list.
  it("still lists the party when mediamtx cannot be reached", async () => {
    postgres.query
      .mockResolvedValueOnce(enabled(true))
      .mockResolvedValueOnce([{ status: "Accepted" }])
      .mockResolvedValueOnce([
        { steam_id: PEER, name: "peer", avatar_url: null },
      ]);
    mediaMtx.listPaths.mockResolvedValue(null);

    const participants = await service.participants(LOBBY_ID, ME);

    expect(participants).toHaveLength(1);
    expect(participants[0].speaking).toBe(false);
  });

  it("drops only your own session on leave", async () => {
    accepted();

    await service.leave(LOBBY_ID, ME);

    expect(mediaMtx.kickSessions).toHaveBeenCalledWith(
      `voice-${LOBBY_ID}-${ME.steam_id}`,
    );
  });

  describe("match lineup channels", () => {
    const LINEUP_ID = "22222222-2222-2222-2222-222222222222";

    // Not in any lobby, but rostered on the lineup: the second lookup is what
    // lets a match channel reuse the lobby transport.
    const rostered = () =>
      postgres.query
        .mockResolvedValueOnce(enabled(true))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ exists: true }]);

    it("admits a player rostered on the lineup", async () => {
      rostered();

      await expect(service.publish(LINEUP_ID, ME, "offer")).resolves.toBe(
        "answer-sdp",
      );
      expect(mediaMtx.proxySdp).toHaveBeenCalledWith(
        `voice-${LINEUP_ID}-${ME.steam_id}`,
        "whip",
        "offer",
      );
    });

    it("refuses someone who is on neither the lobby nor the lineup", async () => {
      postgres.query
        .mockResolvedValueOnce(enabled(true))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(service.publish(LINEUP_ID, ME, "offer")).rejects.toThrow(
        /not a member/i,
      );
      expect(mediaMtx.proxySdp).not.toHaveBeenCalled();
    });

    // The whole point of scoping to a lineup rather than a match: the id is the
    // team, so there is no path that resolves to the opposing side.
    it("only ever addresses paths under the lineup it was given", async () => {
      rostered();

      await service.subscribe(LINEUP_ID, PEER, ME, "offer");

      expect(mediaMtx.proxySdp).toHaveBeenCalledWith(
        `voice-${LINEUP_ID}-${PEER}`,
        "whep",
        "offer",
      );
    });

    it("excludes finished matches from membership", async () => {
      rostered();

      await service.publish(LINEUP_ID, ME, "offer");

      const [sql] = postgres.query.mock.calls[2];
      expect(sql).toMatch(/match_lineup_players/);
      expect(sql).toMatch(/Finished/);
      expect(sql).toMatch(/Canceled/);
    });

    it("lists lineup members as participants", async () => {
      rostered();
      postgres.query.mockResolvedValueOnce([
        { steam_id: ME.steam_id, name: "me", avatar_url: null },
        { steam_id: PEER, name: "peer", avatar_url: null },
      ]);
      mediaMtx.listPaths.mockResolvedValue(
        new Map([[`voice-${LINEUP_ID}-${PEER}`, { ready: true }]]),
      );

      const participants = await service.participants(LINEUP_ID, ME);

      expect(participants.map((p) => p.steamId)).toEqual([ME.steam_id, PEER]);
      expect(participants.find((p) => p.steamId === PEER)?.speaking).toBe(true);
    });
  });
});
