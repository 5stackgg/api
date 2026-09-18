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
  let servers: Record<
    string,
    {
      is_dedicated: boolean;
      reserved_by_match_id?: string | null;
      game_server_node?: { region: string } | null;
    } | null
  >;
  let currentMatch: Record<string, unknown>;

  const stopJobs = () =>
    scheduledMatchesQueue.add.mock.calls.filter(
      ([name]) => name === "StopOnDemandServer",
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
      removeVetoPickTimeout: jest.fn(),
      scheduleVetoPickTimeout: jest.fn(),
      stopOnDemandServer: jest.fn(),
      releaseOnDemandServer: jest.fn(),
      assignServer: jest.fn(),
      reserveDedicatedServer: jest.fn(),
    };
    scheduledMatchesQueue = { add: jest.fn() };
    discordBotMessaging = { removeMatchChannel: jest.fn() };
    utilityPractice = {
      evictForMatch: jest.fn(async (): Promise<void> => undefined),
      markEndedForMatch: jest.fn(),
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
      {
        resolveMatchAlerts: jest.fn(async (): Promise<void> => undefined),
        sendMatchWaitingForServerNotification: jest.fn(
          async (): Promise<void> => undefined,
        ),
      } as any,
      { removeLobby: jest.fn() } as any,
      { add: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn(async (): Promise<void> => undefined) } as any,
      scheduledMatchesQueue as any,
      {} as any,
      { removeBroadcast: jest.fn() } as any,
      {
        createMatchVoiceChannels: jest.fn(),
        movePlayersToMatchChannels: jest.fn(),
      } as any,
      {
        stopLive: jest.fn(),
        stopLiveIfRunning: jest.fn(),
        promotePendingLiveStreams: jest.fn(async () => ({
          promoted: [] as string[],
        })),
      } as any,
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
      expect.objectContaining({ delay: 30 * 1000 }),
    );
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
});
