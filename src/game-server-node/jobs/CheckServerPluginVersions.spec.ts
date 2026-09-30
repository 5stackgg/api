import { CheckServerPluginVersions } from "./CheckServerPluginVersions";

describe("CheckServerPluginVersions", () => {
  it("only counts enabled servers as out of date", async () => {
    const hasura = {
      query: jest.fn(async (query: Record<string, any>) => {
        if (query.notifications_aggregate) {
          return { notifications_aggregate: { aggregate: { count: 0 } } };
        }
        if (query.plugin_versions) {
          return { plugin_versions: [{ version: "2.0.0" }] };
        }
        return { servers_aggregate: { aggregate: { count: 0 } } };
      }),
    };
    const job = new CheckServerPluginVersions(
      hasura as any,
      { send: jest.fn() } as any,
      { getPluginRuntime: jest.fn().mockResolvedValue("swiftlys2") } as any,
    );

    await job.process();

    const [[servers]] = hasura.query.mock.calls.filter(
      ([query]) => query.servers_aggregate,
    );
    expect(servers.servers_aggregate.__args.where.enabled).toEqual({
      _eq: true,
    });
  });
});
