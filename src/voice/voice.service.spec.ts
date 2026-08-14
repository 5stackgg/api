import { Logger } from "@nestjs/common";
import { VoiceService } from "./voice.service";
import { User } from "../auth/types/User";

describe("VoiceService", () => {
  const LOBBY_ID = "11111111-1111-1111-1111-111111111111";
  const ME = { steam_id: "76561198000000001" } as User;
  const PEER = "76561198000000002";

  let postgres: { query: jest.Mock };
  let mediaMtx: { proxySdp: jest.Mock; kickSessions: jest.Mock; listPaths: jest.Mock };
  let redis: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    mget: jest.Mock;
    expire: jest.Mock;
    publish: jest.Mock;
  };
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
    redis = {
      // Nothing cached and nobody speaking, unless a test says otherwise.
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      mget: jest
        .fn()
        .mockImplementation((keys: Array<string>) =>
          Promise.resolve(new Array<string | null>(keys.length).fill(null)),
        ),
      expire: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
    };
    service = new VoiceService(
      new Logger("VoiceTest"),
      postgres as any,
      mediaMtx as any,
      { getConnection: () => redis } as any,
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
      {
        steamId: ME.steam_id,
        name: "me",
        avatarUrl: null,
        connected: false,
        speaking: false,
      },
      {
        steamId: PEER,
        name: "peer",
        avatarUrl: null,
        connected: true,
        speaking: false,
      },
    ]);
  });

  // The distinction the old flag got wrong: MediaMTX only knows a mic is
  // publishing. Whether anyone is talking into it comes from the gate.
  it("marks a publishing member as speaking only once their gate says so", async () => {
    postgres.query
      .mockResolvedValueOnce(enabled(true))
      .mockResolvedValueOnce([{ status: "Accepted" }])
      .mockResolvedValueOnce([{ steam_id: PEER, name: "peer", avatar_url: null }]);
    mediaMtx.listPaths.mockResolvedValue(
      new Map([[`voice-${LOBBY_ID}-${PEER}`, { ready: true }]]),
    );
    redis.mget.mockResolvedValue(["1"]);

    const [participant] = await service.participants(LOBBY_ID, ME);

    expect(participant.connected).toBe(true);
    expect(participant.speaking).toBe(true);
  });

  // A flag left behind by a client that dropped would keep someone lit up.
  it("ignores a speaking flag from a member who is no longer publishing", async () => {
    postgres.query
      .mockResolvedValueOnce(enabled(true))
      .mockResolvedValueOnce([{ status: "Accepted" }])
      .mockResolvedValueOnce([{ steam_id: PEER, name: "peer", avatar_url: null }]);
    mediaMtx.listPaths.mockResolvedValue(new Map());
    redis.mget.mockResolvedValue(["1"]);

    const [participant] = await service.participants(LOBBY_ID, ME);

    expect(participant.connected).toBe(false);
    expect(participant.speaking).toBe(false);
  });

  describe("speaking", () => {
    // Membership comes from the (cached) member list on this path, so there is
    // no enabled/membership round trip to stand up.
    const speak = () =>
      postgres.query.mockResolvedValueOnce([
        { steam_id: ME.steam_id, name: "me", avatar_url: null },
        { steam_id: PEER, name: "peer", avatar_url: null },
      ]);

    it("tells the rest of the channel when a gate opens", async () => {
      speak();

      await service.setSpeaking(LOBBY_ID, ME, true);

      const events = redis.publish.mock.calls.map(([, payload]) =>
        JSON.parse(payload as string),
      );

      expect(events).toHaveLength(2);
      expect(events.map((event) => event.steamId).sort()).toEqual(
        [ME.steam_id, PEER].sort(),
      );
      expect(events[0].event).toBe("voice:speaking");
      expect(events[0].data).toEqual({
        channelId: LOBBY_ID,
        steamId: ME.steam_id,
        speaking: true,
      });
    });

    // Clients refresh the flag while they hold the gate open so it cannot
    // expire under them; re-broadcasting every refresh would be pure noise.
    it("treats a repeat as a keep-alive rather than a transition", async () => {
      speak();
      redis.set.mockResolvedValue(null);

      await service.setSpeaking(LOBBY_ID, ME, true);

      expect(redis.expire).toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("says nothing when the gate was already closed", async () => {
      speak();
      redis.del.mockResolvedValue(0);

      await service.setSpeaking(LOBBY_ID, ME, false);

      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("refuses anyone who is not in the channel", async () => {
      postgres.query.mockResolvedValueOnce([
        { steam_id: PEER, name: "peer", avatar_url: null },
      ]);

      await expect(service.setSpeaking(LOBBY_ID, ME, true)).rejects.toThrow(
        /not a member/i,
      );
      expect(redis.publish).not.toHaveBeenCalled();
    });

    // Reads the cache instead of the database once it is warm: this is the hot
    // path, hit on every open and close of every player's gate.
    it("does not query for membership when the list is cached", async () => {
      redis.get.mockResolvedValue(
        JSON.stringify([
          { steam_id: ME.steam_id, name: "me", avatar_url: null },
        ]),
      );

      await service.setSpeaking(LOBBY_ID, ME, true);

      expect(postgres.query).not.toHaveBeenCalled();
      expect(redis.publish).toHaveBeenCalledTimes(1);
    });
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
    expect(participants[0].connected).toBe(false);
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
      expect(participants.find((p) => p.steamId === PEER)?.connected).toBe(
        true,
      );
    });
  });
  // The publish and leave endpoints cover the polite cases. This is the one
  // that covers a browser that simply died.
  describe("monitorChannels", () => {
    const OTHER = "76561198000000003";

    const path = (steamId: string) => `voice-${LOBBY_ID}-${steamId}`;

    const roster = () =>
      postgres.query.mockResolvedValue([
        { steam_id: ME.steam_id, name: "me", avatar_url: null },
        { steam_id: PEER, name: "peer", avatar_url: null },
      ]);

    // Keyed, so a test cannot pass because the members cache happened to answer
    // with the publishing snapshot (or the other way round).
    const snapshot = (value: string | null) =>
      redis.get.mockImplementation((key: string) =>
        Promise.resolve(
          key === `voice:publishing:${LOBBY_ID}` ? value : null,
        ),
      );

    const pushed = () =>
      redis.publish.mock.calls
        .map(([, payload]) => JSON.parse(payload as string))
        .filter((event) => event.event === "voice:participants");

    it("tells the channel when a member stops publishing", async () => {
      roster();
      snapshot(`${ME.steam_id},${PEER}`);
      mediaMtx.listPaths.mockResolvedValue(
        new Map([[path(ME.steam_id), { ready: true, bytesReceived: 1 }]]),
      );

      await service.monitorChannels();

      expect(pushed()).toHaveLength(2);
      expect(pushed()[0].data.channelId).toBe(LOBBY_ID);
    });

    it("says nothing while the same people are publishing", async () => {
      roster();
      snapshot(`${ME.steam_id},${PEER}`);
      mediaMtx.listPaths.mockResolvedValue(
        new Map([
          [path(ME.steam_id), { ready: true, bytesReceived: 1 }],
          [path(PEER), { ready: true, bytesReceived: 1 }],
        ]),
      );

      await service.monitorChannels();

      expect(pushed()).toHaveLength(0);
    });

    // Order out of MediaMTX is not guaranteed, and a snapshot that flipped with
    // it would announce a change on every other pass.
    it("is not confused by the order paths come back in", async () => {
      roster();
      snapshot([ME.steam_id, PEER].sort().join(","));
      mediaMtx.listPaths.mockResolvedValue(
        new Map([
          [path(PEER), { ready: true, bytesReceived: 1 }],
          [path(ME.steam_id), { ready: true, bytesReceived: 1 }],
        ]),
      );

      await service.monitorChannels();

      expect(pushed()).toHaveLength(0);
    });

    // A restart must not announce a change to every live channel at once.
    it("seeds a channel it has not seen before without announcing", async () => {
      roster();
      snapshot(null);
      mediaMtx.listPaths.mockResolvedValue(
        new Map([[path(ME.steam_id), { ready: true, bytesReceived: 1 }]]),
      );

      await service.monitorChannels();

      expect(redis.set).toHaveBeenCalledWith(
        `voice:publishing:${LOBBY_ID}`,
        ME.steam_id,
        "EX",
        expect.any(Number),
      );
      expect(pushed()).toHaveLength(0);
    });

    it("ignores paths that are not voice", async () => {
      snapshot(null);
      mediaMtx.listPaths.mockResolvedValue(
        new Map([
          [`camera-${LOBBY_ID}-${OTHER}`, { ready: true, bytesReceived: 1 }],
          ["some-stream", { ready: true, bytesReceived: 1 }],
        ]),
      );

      await service.monitorChannels();

      expect(redis.set).not.toHaveBeenCalled();
      expect(pushed()).toHaveLength(0);
    });

    // A path that exists but is not ready has no publisher behind it.
    it("does not count a path that is not ready", async () => {
      roster();
      snapshot(`${ME.steam_id},${PEER}`);
      mediaMtx.listPaths.mockResolvedValue(
        new Map([
          [path(ME.steam_id), { ready: true, bytesReceived: 1 }],
          [path(PEER), { ready: false, bytesReceived: 0 }],
        ]),
      );

      await service.monitorChannels();

      expect(pushed()).toHaveLength(2);
    });

    // Emptying every call because we cannot reach MediaMTX would be far worse
    // than being a pass late on a real drop.
    it("fails open when mediamtx does not answer", async () => {
      mediaMtx.listPaths.mockResolvedValue(null);

      await service.monitorChannels();

      expect(redis.set).not.toHaveBeenCalled();
      expect(pushed()).toHaveLength(0);
    });
  });
});
