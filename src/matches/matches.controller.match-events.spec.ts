jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { MatchesController } from "./matches.controller";

describe("MatchesController — match_events on-demand servers", () => {
  let controller: MatchesController;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let matchAssistant: Record<string, jest.Mock>;
  let scheduledMatchesQueue: { add: jest.Mock };
  let discordBotMessaging: { removeMatchChannel: jest.Mock };
  let utilityPractice: Record<string, jest.Mock>;
  let gameStreamer: Record<string, jest.Mock>;
  let matchRelay: { removeBroadcast: jest.Mock; playoutSeconds: jest.Mock };
  let inPlayMaps: Array<{ id: string }>;
  let servers: Record<
    string,
    {
      is_dedicated: boolean;
      reserved_by_match_id?: string | null;
      game_server_node?: { region: string } | null;
    } | null
  >;
  let currentMatch: Record<string, unknown>;
  let chat: Record<string, jest.Mock>;
  let notifications: Record<string, jest.Mock>;
  let eloCalculationQueue: { add: jest.Mock };
  let tournamentVoice: Record<string, jest.Mock>;

  const stopJobs = () =>
    scheduledMatchesQueue.add.mock.calls.filter(
      ([name]) => name === "StopOnDemandServer",
    );

  const broadcastStopJobs = () =>
    scheduledMatchesQueue.add.mock.calls.filter(
      ([name]) => name === "StopMatchBroadcast",
    );

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "match-1",
    source: "5stack",
    status: "Live",
    region: "USE",
    server_id: "server-1",
    match_options_id: "options-1",
    lineup_1_id: "lineup-1",
    lineup_2_id: "lineup-2",
    ...overrides,
  });

  beforeEach(() => {
    servers = {
      "server-1": {
        is_dedicated: false,
        reserved_by_match_id: "match-1",
        game_server_node: { region: "USE" },
      },
      "server-2": {
        is_dedicated: false,
        reserved_by_match_id: "match-1",
        game_server_node: { region: "USE" },
      },
      "server-3": {
        is_dedicated: false,
        reserved_by_match_id: null,
        game_server_node: { region: "USE" },
      },
      "dedicated-1": { is_dedicated: true, game_server_node: null },
    };
    currentMatch = {
      id: "match-1",
      options: { prefer_dedicated_server: false },
      server: {
        id: "server-2",
        is_dedicated: false,
        reserved_by_match_id: "match-1",
        game_server_node_id: "node-1",
      },
    };

    hasura = {
      query: jest.fn(async (request: any) => {
        if (request.servers_by_pk) {
          return {
            servers_by_pk: servers[request.servers_by_pk.__args.id] ?? null,
          };
        }
        if (request.match_maps) {
          return {
            match_maps: inPlayMaps,
            match_options_by_pk: { tv_delay: 30 },
          };
        }
        if (request.match_options_by_pk) {
          return { match_options_by_pk: { tv_delay: 30 } };
        }
        if (request.matches_by_pk) {
          return { matches_by_pk: currentMatch };
        }
        return {};
      }),
      mutation: jest.fn(async (request: any) =>
        request.update_matches ? { update_matches: { affected_rows: 1 } } : {},
      ),
    };
    matchAssistant = {
      stopOnDemandServer: jest.fn(),
      releaseOnDemandServer: jest.fn(),
      assignServer: jest.fn(),
      assignWaitingMatch: jest.fn(),
      reserveDedicatedServer: jest.fn(),
    };
    scheduledMatchesQueue = { add: jest.fn() };
    discordBotMessaging = { removeMatchChannel: jest.fn() };
    utilityPractice = {
      evictForMatch: jest.fn(async (): Promise<void> => undefined),
      markEndedForMatch: jest.fn(),
    };
    gameStreamer = {
      stopLive: jest.fn(),
      stopLiveIfRunning: jest.fn(),
      getLiveStreamMode: jest.fn(async (): Promise<string | null> => "tv"),
      promotePendingLiveStreams: jest.fn(async () => ({
        promoted: [] as string[],
      })),
    };
    matchRelay = {
      removeBroadcast: jest.fn(async (): Promise<void> => undefined),
      playoutSeconds: jest.fn(async () => 0),
    };
    inPlayMaps = [];
    tournamentVoice = {
      createMatchVoiceChannels: jest.fn(),
      movePlayersToMatchChannels: jest.fn(),
    };
    notifications = {
      resolveMatchAlerts: jest.fn(async (): Promise<void> => undefined),
      sendMatchWaitingForServerNotification: jest.fn(
        async (): Promise<void> => undefined,
      ),
    };
    eloCalculationQueue = { add: jest.fn() };
    chat = {
      removeLobby: jest.fn(),
      removeMatchArchive: jest.fn(),
      anchorMatchArchive: jest.fn(),
      reopenMatchArchive: jest.fn(),
      endMatchLobby: jest.fn(),
    };

    controller = new MatchesController(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      hasura as any,
      { query: jest.fn(async (): Promise<unknown[]> => []) } as any,
      { get: jest.fn(() => ({})) } as any,
      { cancelMatchMakingByMatchId: jest.fn() } as any,
      matchAssistant as any,
      discordBotMessaging as any,
      { updateMatchOverview: jest.fn() } as any,
      { removeTeamChannels: jest.fn() } as any,
      notifications as any,
      chat as any,
      eloCalculationQueue as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn(async (): Promise<void> => undefined) } as any,
      scheduledMatchesQueue as any,
      {} as any,
      matchRelay as any,
      tournamentVoice as any,
      gameStreamer as any,
      {} as any,
      { resumeAllPausedBatches: jest.fn() } as any,
      {} as any,
      {} as any,
      { clearMatch: jest.fn() } as any,
      { closeChannel: jest.fn(), graceOnMatchEnd: jest.fn() } as any,
      utilityPractice as any,
      {} as any,
    );
  });

  describe("the chat archive", () => {
    it("goes with a deleted match", async () => {
      await controller.match_events({
        op: "DELETE",
        old: row(),
        new: {},
      } as any);

      expect(chat.removeMatchArchive).toHaveBeenCalledWith("match-1");
    });

    it.each(["Finished", "Tie", "Canceled", "Forfeit", "Surrendered"])(
      "stops sliding once the match is %s",
      async (ended) => {
        await controller.match_events({
          op: "UPDATE",
          old: row({ status: "Live" }),
          new: row({ status: ended }),
        } as any);

        expect(chat.anchorMatchArchive).toHaveBeenCalledWith("match-1");
        expect(chat.reopenMatchArchive).not.toHaveBeenCalled();
      },
    );

    it.each(["Finished", "Tie", "Canceled", "Forfeit", "Surrendered"])(
      "ends the match lobby's in-game state once the match is %s",
      async (ended) => {
        await controller.match_events({
          op: "UPDATE",
          old: row({ status: "Live" }),
          new: row({ status: ended }),
        } as any);

        expect(chat.endMatchLobby).toHaveBeenCalledWith("match-1");
      },
    );

    it("still finishes ending the match when the lobby cannot be cleaned up", async () => {
      chat.endMatchLobby.mockRejectedValue(new Error("redis unavailable"));

      await controller.match_events({
        op: "UPDATE",
        old: row({ status: "Live" }),
        new: row({ status: "Finished" }),
      } as any);

      expect(notifications.resolveMatchAlerts).toHaveBeenCalledWith("match-1");
      expect(eloCalculationQueue.add).toHaveBeenCalledWith("EloCalculation", {
        matchId: "match-1",
      });
      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_matches_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              _set: { server_id: null },
            }),
          }),
        }),
      );
    });

    it("is not anchored again by a later update of an ended match", async () => {
      await controller.match_events({
        op: "UPDATE",
        old: row({ status: "Canceled" }),
        new: row({ status: "Finished" }),
      } as any);

      expect(chat.anchorMatchArchive).not.toHaveBeenCalled();
      expect(chat.endMatchLobby).not.toHaveBeenCalled();
    });

    it("slides again even when the match's voice channels cannot be made", async () => {
      tournamentVoice.createMatchVoiceChannels.mockRejectedValue(
        new Error("discord unavailable"),
      );

      await controller
        .match_events({
          op: "UPDATE",
          old: row({ status: "Canceled" }),
          new: row({ status: "WaitingForCheckIn" }),
        } as any)
        .catch((): void => undefined);

      expect(chat.reopenMatchArchive).toHaveBeenCalledWith("match-1");
    });

    it("slides again when an ended match is started again", async () => {
      await controller.match_events({
        op: "UPDATE",
        old: row({ status: "Canceled" }),
        new: row({ status: "Live" }),
      } as any);

      expect(chat.reopenMatchArchive).toHaveBeenCalledWith("match-1");
      expect(chat.anchorMatchArchive).not.toHaveBeenCalled();
    });
  });

  it("stops the on-demand server of a match that is deleted", async () => {
    await controller.match_events({
      op: "DELETE",
      old: row(),
      new: {},
    } as any);

    expect(stopJobs()).toHaveLength(1);

    const [[, data, options]] = stopJobs();

    expect(data).toEqual({ matchId: "match-1" });
    expect(options?.delay ?? 0).toBe(0);
    expect(options?.attempts).toBeGreaterThan(1);
  });

  it("stops the server even when an end-of-match side effect throws", async () => {
    discordBotMessaging.removeMatchChannel.mockRejectedValue(
      new Error("discord unavailable"),
    );

    await controller
      .match_events({
        op: "UPDATE",
        old: row({ status: "Live" }),
        new: row({ status: "Finished" }),
      } as any)
      .catch((): void => undefined);

    expect(stopJobs()).toHaveLength(1);
    expect(stopJobs()[0][2]).toEqual(
      expect.objectContaining({ delay: 10 * 1000 }),
    );
  });

  it("retries the event when it cannot tell how far behind the TV feed is", async () => {
    const answer = hasura.query.getMockImplementation()!;
    hasura.query.mockImplementation(async (request: any) => {
      if (request.match_maps) {
        throw new Error("hasura unavailable");
      }
      return answer(request);
    });

    await expect(
      controller.match_events({
        op: "UPDATE",
        old: row({ status: "Live" }),
        new: row({ status: "Finished" }),
      } as any),
    ).rejects.toThrow("hasura unavailable");

    expect(stopJobs()).toHaveLength(0);
  });

  it("still ends the broadcast when it cannot tell how far behind the TV feed is", async () => {
    const answer = hasura.query.getMockImplementation()!;
    hasura.query.mockImplementation(async (request: any) => {
      if (request.match_maps) {
        throw new Error("hasura unavailable");
      }
      return answer(request);
    });

    await controller
      .match_events({
        op: "UPDATE",
        old: row({ status: "Live", server_id: "dedicated-1" }),
        new: row({ status: "Finished", server_id: "dedicated-1" }),
      } as any)
      .catch((): void => undefined);

    expect(broadcastStopJobs()[0][2].delay).toBe(5 * 1000);
  });

  // The plugin waits out tv_delay before it finishes the map, then stops the TV
  // 5s later, and the server outlives that by as much again.
  it("stops a finished match's server once the plugin has stopped the TV", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Live" }),
      new: row({ status: "Finished" }),
    } as any);

    expect(stopJobs()[0][2]).toEqual(
      expect.objectContaining({ delay: 10 * 1000 }),
    );
  });

  it("waits out tv_delay before stopping the server of a match ended mid-map", async () => {
    inPlayMaps = [{ id: "map-1" }];

    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Live" }),
      new: row({ status: "Forfeit" }),
    } as any);

    expect(stopJobs()[0][2]).toEqual(
      expect.objectContaining({ delay: 35 * 1000 }),
    );
  });

  it("waits out tv_delay before stopping a server still recording the map", async () => {
    const answer = hasura.query.getMockImplementation()!;
    hasura.query.mockImplementation(async (request: any) =>
      request.match_maps
        ? {
            match_maps: request.match_maps.__args.where.status._in.includes(
              "WaitingForTV",
            )
              ? [{ id: "map-1" }]
              : [],
            match_options_by_pk: { tv_delay: 30 },
          }
        : answer(request),
    );

    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Live" }),
      new: row({ status: "Forfeit" }),
    } as any);

    expect(stopJobs()[0][2]).toEqual(
      expect.objectContaining({ delay: 35 * 1000 }),
    );
    expect(broadcastStopJobs()[0][2].delay).toBe(5 * 1000);
  });

  it("stops the server an ended match ended on as soon as it is played again", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Canceled", server_id: null }),
      new: row({ status: "WaitingForCheckIn", server_id: null }),
    } as any);

    expect(stopJobs()).toHaveLength(1);
    expect(stopJobs()[0][1]).toEqual({ matchId: "match-1" });
    expect(stopJobs()[0][2]?.delay ?? 0).toBe(0);
  });

  it("hands a node that comes online to as many waiting matches as it has free servers", async () => {
    const answer = hasura.query.getMockImplementation()!;
    hasura.query.mockImplementation(async (request: any) =>
      request.game_server_nodes_by_pk
        ? {
            game_server_nodes_by_pk: {
              gpu: false,
              servers_aggregate: { aggregate: { count: 2 } },
            },
          }
        : answer(request),
    );

    await controller.node_server_availability({
      op: "UPDATE",
      old: { id: "node-1", status: "Offline" },
      new: { id: "node-1", status: "Online", enabled: true, region: "USE" },
    } as any);

    expect(matchAssistant.assignWaitingMatch.mock.calls).toEqual([
      ["USE"],
      ["USE"],
    ]);
  });

  describe("a server that becomes free", () => {
    const freed = (overrides: Record<string, unknown> = {}) =>
      controller.server_availability({
        op: "UPDATE",
        old: { id: "server-1", reserved_by_match_id: "match-1" },
        new: {
          id: "server-1",
          region: "USE",
          enabled: true,
          connected: true,
          is_dedicated: true,
          reserved_by_match_id: null,
          ...overrides,
        },
      } as any);

    it("goes to the oldest waiting match in its region", async () => {
      await freed();

      expect(matchAssistant.assignWaitingMatch).toHaveBeenCalledWith("USE");
    });

    it("is not handed out when it is a dedicated server that is not up", async () => {
      await freed({ connected: false });

      expect(matchAssistant.assignWaitingMatch).not.toHaveBeenCalled();
    });

    // The api hands out one it freed itself; nobody is woken when an assignment gives one back.
    it("is not handed out when the api frees an on-demand one", async () => {
      await freed({ connected: false, is_dedicated: false });

      expect(matchAssistant.assignWaitingMatch).not.toHaveBeenCalled();
      expect(matchAssistant.assignServer).not.toHaveBeenCalled();
    });

    it("is not handed out when a new on-demand server is added", async () => {
      await controller.server_availability({
        op: "INSERT",
        old: null,
        new: {
          id: "server-4",
          region: "USE",
          enabled: true,
          connected: false,
          is_dedicated: false,
          reserved_by_match_id: null,
        },
      } as any);

      expect(matchAssistant.assignWaitingMatch).not.toHaveBeenCalled();
    });
  });

  it("stops a canceled match's server straight away", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "WaitingForServer" }),
      new: row({ status: "Canceled" }),
    } as any);

    expect(stopJobs()).toHaveLength(1);
    expect(stopJobs()[0][2]?.delay ?? 0).toBe(0);
  });

  it("stops the server when its row is already gone", async () => {
    servers["server-1"] = null;

    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Live" }),
      new: row({ status: "Canceled" }),
    } as any);

    expect(stopJobs()).toHaveLength(1);
  });

  it("leaves a dedicated server running", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Live", server_id: "dedicated-1" }),
      new: row({ status: "Finished", server_id: "dedicated-1" }),
    } as any);

    expect(stopJobs()).toHaveLength(0);
  });

  it("stops the server of a match ended and taken off it in one write", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Live" }),
      new: row({ status: "Canceled", server_id: null }),
    } as any);

    expect(stopJobs()).toHaveLength(1);
  });

  it("does not stop again when its own server_id write re-fires the event", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Finished" }),
      new: row({ status: "Finished", server_id: null }),
    } as any);

    expect(stopJobs()).toHaveLength(0);
  });

  it("releases only the old row when a reboot moves the match onto a new on-demand server", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ server_id: "server-1" }),
      new: row({ server_id: "server-2" }),
    } as any);

    expect(matchAssistant.stopOnDemandServer).not.toHaveBeenCalled();
    expect(matchAssistant.releaseOnDemandServer).toHaveBeenCalledWith(
      "match-1",
      "server-1",
    );
  });

  it("stops the old on-demand server when the match moves onto a dedicated one", async () => {
    currentMatch = {
      ...currentMatch,
      server: {
        id: "dedicated-1",
        is_dedicated: true,
        reserved_by_match_id: "match-1",
        game_server_node_id: null,
      },
    };

    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "WaitingForServer", server_id: "server-1" }),
      new: row({ status: "WaitingForServer", server_id: "dedicated-1" }),
    } as any);

    expect(matchAssistant.stopOnDemandServer).toHaveBeenCalledWith("match-1", {
      serverId: "server-1",
    });
    expect(matchAssistant.releaseOnDemandServer).not.toHaveBeenCalled();
  });

  it("still stops the server when it is taken off the match", async () => {
    currentMatch = { ...currentMatch, server: null };

    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "WaitingForServer", server_id: "server-1" }),
      new: row({ status: "WaitingForServer", server_id: null }),
    } as any);

    expect(matchAssistant.stopOnDemandServer).toHaveBeenCalledWith("match-1");
  });

  it("leaves the server alone when only the region changes", async () => {
    currentMatch = { ...currentMatch, server: null };

    await controller.match_events({
      op: "UPDATE",
      old: row({ status: "Live", region: null, server_id: null }),
      new: row({ status: "Live", region: "USE", server_id: null }),
    } as any);

    expect(matchAssistant.stopOnDemandServer).not.toHaveBeenCalled();
  });

  const serverClears = () =>
    hasura.mutation.mock.calls
      .map(([request]) => request.update_matches?.__args)
      .filter(Boolean);

  it("hands a server picked by hand back to assignment, since nothing booted it", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ server_id: "server-1" }),
      new: row({ server_id: "server-3" }),
    } as any);

    expect(serverClears()).toEqual([
      {
        where: { id: { _eq: "match-1" }, server_id: { _eq: "server-3" } },
        _set: { server_id: null },
      },
    ]);
    expect(matchAssistant.stopOnDemandServer).not.toHaveBeenCalled();
    expect(matchAssistant.releaseOnDemandServer).not.toHaveBeenCalled();
    expect(matchAssistant.assignServer).not.toHaveBeenCalled();
  });

  it("moves an on-demand server off a region the match left", async () => {
    await controller.match_events({
      op: "UPDATE",
      old: row({ region: "USE", server_id: "server-1" }),
      new: row({ region: "EUW", server_id: "server-1" }),
    } as any);

    expect(serverClears()).toEqual([
      {
        where: { id: { _eq: "match-1" }, server_id: { _eq: "server-1" } },
        _set: { server_id: null },
      },
    ]);
    expect(matchAssistant.stopOnDemandServer).not.toHaveBeenCalled();
    expect(matchAssistant.releaseOnDemandServer).not.toHaveBeenCalled();
    expect(matchAssistant.assignServer).not.toHaveBeenCalled();
  });

  it.each([
    ["an on-demand server already in the new region", null, "server-1"],
    ["a dedicated server", "EUW", "dedicated-1"],
  ])(
    "keeps %s when only the region changes",
    async (_label, oldRegion, serverId) => {
      currentMatch = {
        ...currentMatch,
        server: {
          id: serverId,
          is_dedicated: serverId === "dedicated-1",
          reserved_by_match_id: "match-1",
          game_server_node_id: null,
        },
      };

      await controller.match_events({
        op: "UPDATE",
        old: row({ region: oldRegion, server_id: serverId }),
        new: row({ region: "USE", server_id: serverId }),
      } as any);

      expect(serverClears()).toEqual([]);
      expect(matchAssistant.stopOnDemandServer).not.toHaveBeenCalled();
      expect(matchAssistant.releaseOnDemandServer).not.toHaveBeenCalled();
    },
  );

  describe("a practice match", () => {
    it("stops the server even when ending the session throws", async () => {
      utilityPractice.markEndedForMatch.mockRejectedValue(
        new Error("session update failed"),
      );

      await controller
        .match_events({
          op: "UPDATE",
          old: row({ source: "practice", status: "Live" }),
          new: row({ source: "practice", status: "Canceled" }),
        } as any)
        .catch((): void => undefined);

      expect(stopJobs()).toHaveLength(1);
      expect(stopJobs()[0][2]?.attempts).toBeGreaterThan(1);
    });

    it("does not stop again when its own server_id write re-fires the event", async () => {
      await controller.match_events({
        op: "UPDATE",
        old: row({ source: "practice", status: "Canceled" }),
        new: row({ source: "practice", status: "Canceled", server_id: null }),
      } as any);

      expect(stopJobs()).toHaveLength(0);
    });

    it("stops the server of a practice match that is deleted", async () => {
      await controller.match_events({
        op: "DELETE",
        old: row({ source: "practice", status: "Live" }),
        new: {},
      } as any);

      expect(stopJobs()).toHaveLength(1);
    });
  });

  describe("the broadcast of a match that ends", () => {
    const finish = () =>
      controller
        .match_events({
          op: "UPDATE",
          old: row({ status: "Live" }),
          new: row({ status: "Finished" }),
        } as any)
        .catch((): void => undefined);

    const broadcastStopDelay = () => broadcastStopJobs()[0][2].delay;

    it("keeps a TV stream up until the plugin stops the TV", async () => {
      await finish();

      expect(gameStreamer.stopLive).not.toHaveBeenCalled();
      expect(gameStreamer.stopLiveIfRunning).not.toHaveBeenCalled();
      expect(matchRelay.removeBroadcast).not.toHaveBeenCalled();

      expect(broadcastStopJobs()).toHaveLength(1);
      const [[, data]] = broadcastStopJobs();
      expect(data).toEqual({ matchId: "match-1" });
      // The plugin already waited out tv_delay before finishing the map, and
      // runs tv_stop 5s later.
      expect(broadcastStopDelay()).toBe(5 * 1000);
    });

    it("lets relay viewers play out what they had buffered", async () => {
      matchRelay.playoutSeconds.mockResolvedValue(24);

      await finish();

      expect(matchRelay.playoutSeconds).toHaveBeenCalledWith("match-1");
      expect(broadcastStopDelay()).toBe((5 + 24) * 1000);
    });

    it("waits out tv_delay when an organizer ends the match mid-map", async () => {
      // A winner set by hand reads Finished, so only the map still being
      // played gives away that the TV feed is behind.
      inPlayMaps = [{ id: "map-1" }];

      await finish();

      expect(broadcastStopDelay()).toBe(30 * 1000);
    });

    it("adds the relay play-out on top of tv_delay mid-map", async () => {
      inPlayMaps = [{ id: "map-1" }];
      matchRelay.playoutSeconds.mockResolvedValue(24);

      await finish();

      expect(broadcastStopDelay()).toBe((30 + 24) * 1000);
    });

    it("schedules the stop once, not on every later update", async () => {
      await controller
        .match_events({
          op: "UPDATE",
          old: row({ status: "Finished" }),
          new: row({ status: "Finished", server_id: null }),
        } as any)
        .catch((): void => undefined);

      expect(broadcastStopJobs()).toHaveLength(0);
      expect(gameStreamer.stopLiveIfRunning).not.toHaveBeenCalled();
    });

    it("stops a live-mode stream straight away but still waits on the relay", async () => {
      gameStreamer.getLiveStreamMode.mockResolvedValue("live");

      await finish();

      expect(gameStreamer.stopLiveIfRunning).toHaveBeenCalledWith("match-1");
      expect(matchRelay.removeBroadcast).not.toHaveBeenCalled();
      expect(broadcastStopJobs()).toHaveLength(1);
    });

    it("tears down a canceled match straight away", async () => {
      await controller.match_events({
        op: "UPDATE",
        old: row({ status: "Live" }),
        new: row({ status: "Canceled" }),
      } as any);

      expect(gameStreamer.stopLiveIfRunning).toHaveBeenCalledWith("match-1");
      expect(matchRelay.removeBroadcast).toHaveBeenCalledWith("match-1");
      expect(broadcastStopJobs()).toHaveLength(0);
    });

    it("tears down a deleted match straight away", async () => {
      await controller.match_events({
        op: "DELETE",
        old: row(),
        new: {},
      } as any);

      expect(gameStreamer.stopLive).toHaveBeenCalledWith("match-1");
      expect(matchRelay.removeBroadcast).toHaveBeenCalledWith("match-1");
      expect(broadcastStopJobs()).toHaveLength(0);
    });

    it("tears down straight away when the delayed stop cannot be scheduled", async () => {
      scheduledMatchesQueue.add.mockImplementation(async (name: string) => {
        if (name === "StopMatchBroadcast") {
          throw new Error("redis unavailable");
        }
      });

      await finish();

      expect(gameStreamer.stopLiveIfRunning).toHaveBeenCalledWith("match-1");
      expect(matchRelay.removeBroadcast).toHaveBeenCalledWith("match-1");
    });
  });
});
