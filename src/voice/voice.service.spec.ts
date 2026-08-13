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
});
