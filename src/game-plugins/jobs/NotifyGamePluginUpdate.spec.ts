import { NotifyGamePluginUpdate } from "./NotifyGamePluginUpdate";

describe("NotifyGamePluginUpdate", () => {
  let postgres: { query: jest.Mock };
  let notifications: { send: jest.Mock };
  let job: NotifyGamePluginUpdate;

  const run = (data: Record<string, any>) => job.process({ data } as any);

  const sent = () => notifications.send.mock.calls[0]?.[1];

  const updated = {
    slug: "retakes",
    name: "Retakes",
    version: "1.2.0",
    previousVersion: "1.1.0",
    error: null as string | null,
    outcome: "updated",
    nodes: ["node-1"],
  };

  const failed = {
    ...updated,
    outcome: "failed",
    error: "digest mismatch",
  };

  beforeEach(() => {
    postgres = { query: jest.fn(async (): Promise<Array<any>> => []) };
    notifications = { send: jest.fn(async (): Promise<void> => undefined) };

    job = new NotifyGamePluginUpdate(
      { warn: jest.fn() } as any,
      postgres as any,
      notifications as any,
    );
  });

  it("names both versions and how far the update reached", async () => {
    postgres.query.mockResolvedValue([{ count: "3" }]);

    await run(updated);

    expect(sent().message).toContain(
      "Retakes auto-updated from 1.1.0 to 1.2.0",
    );
    expect(sent().message).toContain("3 nodes");
  });

  // A node installing the plugin for the first time is also on the new
  // version, and it did not update -- counting it says four nodes updated when
  // three did.
  it("counts only the nodes that replaced a version", async () => {
    await run(updated);

    const [sql] = postgres.query.mock.calls[0];

    expect(sql).toContain("previous_version IS NOT NULL");
    expect(sql).toContain("previous_version <> version");
  });

  // The failed row is gone by now: the inventory report at the end of the same
  // pass writes it back to Installed at the version that is still on disk. If
  // this asked the table anything it would find nothing and say nothing.
  it("reports a failure the inventory report has already overwritten", async () => {
    postgres.query.mockResolvedValue([]);

    await run(failed);

    expect(notifications.send).toHaveBeenCalled();
    expect(sent().message).toContain("could not install 1.2.0");
    expect(sent().message).toContain("digest mismatch");
    expect(sent().message).toContain("still running 1.1.0");
  });

  it("names nodes by the label the panel shows", async () => {
    postgres.query.mockResolvedValue([
      { label: "rack-a" },
      { label: "rack-b" },
    ]);

    await run({ ...failed, nodes: ["7f3a", "9c1b"] });

    expect(sent().message).toContain("rack-a, rack-b");
    expect(sent().message).not.toContain("7f3a");
  });

  it("falls back to the id for a node with no label", async () => {
    postgres.query.mockResolvedValue([]);

    await run({ ...failed, nodes: ["node-1"] });

    expect(sent().message).toContain("node-1");
  });

  // Both notices are per release rather than per type, so the bell and the
  // device thread one release's news together instead of collapsing it onto
  // an unrelated node alert.
  it("keys each notice to the release it is about", async () => {
    await run(updated);

    expect(sent().entity_id).toEqual("game_plugin_updated:retakes:1.2.0");
  });

  it("keeps a failure in its own thread", async () => {
    await run(failed);

    expect(sent().entity_id).toEqual("game_plugin_update_failed:retakes:1.2.0");
  });
});
