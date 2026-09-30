import { MarkGameServerNodeOnline } from "./MarkGameServerNodeOnline";

describe("MarkGameServerNodeOnline", () => {
  let region: string | null;
  let regionStatus: string;
  let lastAlerts: Record<string, string | null>;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let notifications: { send: jest.Mock; latestTitle: jest.Mock };
  let job: MarkGameServerNodeOnline;

  beforeEach(() => {
    region = "us-east";
    regionStatus = "Online";
    lastAlerts = {};

    hasura = {
      query: jest.fn(async (query: Record<string, unknown>) => {
        if (query.game_server_nodes_by_pk) {
          return { game_server_nodes_by_pk: { region } };
        }
        if (query.server_regions_by_pk) {
          return {
            server_regions_by_pk: {
              value: "us-east",
              description: "US East",
              status: regionStatus,
            },
          };
        }
        throw new Error(`unexpected query ${Object.keys(query)}`);
      }),
      mutation: jest
        .fn()
        .mockResolvedValue({ update_notifications: { __typename: "x" } }),
    };
    notifications = {
      send: jest.fn().mockResolvedValue(undefined),
      latestTitle: jest.fn(
        async (_type: string, entityId: string) => lastAlerts[entityId] ?? null,
      ),
    };
    job = new MarkGameServerNodeOnline(hasura as any, notifications as any);
  });

  const run = () =>
    job.process({ data: { node: "node-1", label: "node-1" } } as any);

  const sentTitles = () =>
    notifications.send.mock.calls.map(([, notification]) => notification.title);

  it("closes the node's offline alert", async () => {
    lastAlerts["node-1"] = "Game Server Node Offline";

    await run();

    expect(notifications.latestTitle).toHaveBeenCalledWith(
      "GameNodeStatus",
      "node-1",
      ["Game Server Node Offline", "Game Server Node Online"],
    );
    expect(sentTitles()).toEqual(["Game Server Node Online"]);
  });

  it("stays quiet for a node whose outage was never announced", async () => {
    await run();

    expect(sentTitles()).toEqual([]);
  });

  it("does not announce a node twice", async () => {
    lastAlerts["node-1"] = "Game Server Node Online";

    await run();

    expect(sentTitles()).toEqual([]);
  });

  it("closes the region's offline alert once the region is back", async () => {
    lastAlerts["node-1"] = "Game Server Node Offline";
    lastAlerts["us-east"] = "Region Offline";

    await run();

    expect(notifications.latestTitle).toHaveBeenCalledWith(
      "GameNodeStatus",
      "us-east",
      ["Region Offline", "Region Online"],
    );
    expect(sentTitles()).toEqual(["Game Server Node Online", "Region Online"]);
  });

  it("does not announce a region that was never reported offline", async () => {
    lastAlerts["node-1"] = "Game Server Node Offline";
    regionStatus = "Partial";

    await run();

    expect(sentTitles()).toEqual(["Game Server Node Online"]);
  });

  it("does not announce a region twice", async () => {
    lastAlerts["node-1"] = "Game Server Node Offline";
    lastAlerts["us-east"] = "Region Online";

    await run();

    expect(sentTitles()).toEqual(["Game Server Node Online"]);
  });

  it("does not announce a region that is still offline", async () => {
    lastAlerts["node-1"] = "Game Server Node Offline";
    lastAlerts["us-east"] = "Region Offline";
    regionStatus = "Offline";

    await run();

    expect(sentTitles()).toEqual(["Game Server Node Online"]);
  });
});
