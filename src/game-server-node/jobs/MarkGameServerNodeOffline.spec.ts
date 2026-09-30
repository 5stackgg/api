import { MarkGameServerNodeOffline } from "./MarkGameServerNodeOffline";

type Node = {
  status: string;
  enabled: boolean;
  enabled_for_match_making: boolean;
  gpu_streaming_enabled: boolean;
  gpu_demos_enabled: boolean;
  gpu_rendering_enabled: boolean;
  servers: Array<{ id: string }>;
  region: string | null;
};

const matchNode = (fields: Partial<Node> = {}): Node => ({
  status: "Online",
  enabled: true,
  enabled_for_match_making: true,
  gpu_streaming_enabled: true,
  gpu_demos_enabled: true,
  gpu_rendering_enabled: true,
  servers: [],
  region: "us-east",
  ...fields,
});

const gpuNode = (fields: Partial<Node> = {}): Node =>
  matchNode({ enabled_for_match_making: false, region: null, ...fields });

describe("MarkGameServerNodeOffline", () => {
  let node: Node | null;
  let regionBefore: string;
  let regionAfter: string;
  let lastRegionAlert: string | null;
  let stuckMatches: Array<Record<string, unknown>>;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let notifications: { send: jest.Mock; latestTitle: jest.Mock };
  let job: MarkGameServerNodeOffline;

  beforeEach(() => {
    regionBefore = "Online";
    regionAfter = "Partial";
    lastRegionAlert = null;
    stuckMatches = [];

    hasura = {
      query: jest.fn(async (query: Record<string, unknown>) => {
        if (query.game_server_nodes_by_pk) {
          return {
            game_server_nodes_by_pk: node && {
              ...node,
              e_region: node.region ? { status: regionBefore } : null,
            },
          };
        }
        if (query.server_regions_by_pk) {
          return {
            server_regions_by_pk: {
              value: "us-east",
              description: "US East",
              status: regionAfter,
            },
          };
        }
        if (query.matches) {
          return { matches: stuckMatches };
        }
        if (query.server_regions) {
          return {
            server_regions: [{ value: "us-east", status: regionAfter }],
          };
        }
        throw new Error(`unexpected query ${Object.keys(query)}`);
      }),
      mutation: jest.fn(async (mutation: Record<string, unknown>) => {
        if (mutation.update_game_server_nodes_by_pk) {
          return {
            update_game_server_nodes_by_pk: node && {
              label: "node-1",
              region: node.region,
            },
          };
        }
        return { update_notifications: { __typename: "x" } };
      }),
    };
    notifications = {
      send: jest.fn().mockResolvedValue(undefined),
      latestTitle: jest.fn(async () => lastRegionAlert),
    };
    job = new MarkGameServerNodeOffline(hasura as any, notifications as any);
  });

  const run = () => job.process({ data: { node: "node-1" } } as any);

  const markedOffline = () =>
    hasura.mutation.mock.calls.some(
      ([mutation]) =>
        mutation.update_game_server_nodes_by_pk?.__args._set.status ===
        "Offline",
    );

  const sentTitles = () =>
    notifications.send.mock.calls.map(([, notification]) => notification.title);

  it("alerts when a node in service goes offline", async () => {
    node = matchNode();

    await run();

    expect(markedOffline()).toBe(true);
    expect(sentTitles()).toEqual(["Game Server Node Offline"]);
  });

  it("marks a disabled node offline without alerting", async () => {
    node = matchNode({ enabled: false });

    await run();

    expect(markedOffline()).toBe(true);
    expect(sentTitles()).toEqual([]);
  });

  it("alerts for a disabled node still hosting an enabled dedicated server", async () => {
    node = matchNode({ enabled: false, servers: [{ id: "server-1" }] });

    await run();

    expect(sentTitles()).toEqual(["Game Server Node Offline"]);
  });

  it("asks only for enabled dedicated servers when deciding", async () => {
    node = matchNode();

    await run();

    const [[query]] = hasura.query.mock.calls;
    expect(query.game_server_nodes_by_pk.servers.__args.where).toEqual({
      is_dedicated: { _eq: true },
      enabled: { _eq: true },
    });
  });

  it("stays quiet for a GPU node with every workload turned off", async () => {
    node = gpuNode({
      gpu_streaming_enabled: false,
      gpu_demos_enabled: false,
      gpu_rendering_enabled: false,
    });

    await run();

    expect(markedOffline()).toBe(true);
    expect(sentTitles()).toEqual([]);
  });

  it("alerts for a GPU node still taking a workload", async () => {
    node = gpuNode({ gpu_demos_enabled: false, gpu_rendering_enabled: false });

    await run();

    expect(sentTitles()).toEqual(["Game Server Node Offline"]);
  });

  it("does nothing for a node that is already offline", async () => {
    node = matchNode({ status: "Offline" });

    await run();

    expect(markedOffline()).toBe(false);
    expect(sentTitles()).toEqual([]);
  });

  it("does nothing for a node that no longer exists", async () => {
    node = null;

    await run();

    expect(sentTitles()).toEqual([]);
  });

  it("raises the region alert when this node takes the region down", async () => {
    node = matchNode();
    regionAfter = "Offline";

    await run();

    expect(sentTitles()).toEqual([
      "Game Server Node Offline",
      "Region Offline",
    ]);
  });

  it("does not repeat a region alert already raised", async () => {
    node = matchNode({ status: "NotAcceptingNewMatches" });
    regionBefore = "Offline";
    regionAfter = "Offline";
    lastRegionAlert = "Region Offline";

    await run();

    expect(notifications.latestTitle).toHaveBeenCalledWith(
      "GameNodeStatus",
      "us-east",
      ["Region Offline", "Region Online"],
    );
    expect(sentTitles()).toEqual(["Game Server Node Offline"]);
  });

  it("raises the region alert for a region that went offline unannounced", async () => {
    node = matchNode({ status: "NotAcceptingNewMatches" });
    regionBefore = "Offline";
    regionAfter = "Offline";
    lastRegionAlert = "Region Online";
    stuckMatches = [
      { id: "match-1", region: "us-east", status: "Scheduled", options: null },
    ];

    await run();

    expect(sentTitles()).toEqual([
      "Game Server Node Offline",
      "Region Offline",
      "Match stuck: no regions available",
    ]);
  });

  it("raises no region alert for a disabled node in an offline region", async () => {
    node = matchNode({ enabled: false });
    regionBefore = "Offline";
    regionAfter = "Offline";

    await run();

    expect(sentTitles()).toEqual([]);
  });
});
