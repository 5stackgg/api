import { NotifyGamePluginUpdate } from "./NotifyGamePluginUpdate";

describe("NotifyGamePluginUpdate", () => {
  let postgres: { query: jest.Mock };
  let notifications: { send: jest.Mock };
  let job: NotifyGamePluginUpdate;

  const run = (data: Record<string, any>) => job.process({ data } as any);

  const sent = () => notifications.send.mock.calls[0]?.[1];

  const updated = {
    slug: "retakes",
    version: "1.2.0",
    previousVersion: "1.1.0",
    outcome: "updated",
    nodeId: "node-1",
  };

  const failed = { ...updated, outcome: "failed" };

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
    postgres.query
      .mockResolvedValueOnce([{ name: "Retakes", channel: "Auto" }])
      .mockResolvedValueOnce([{ count: "3" }]);

    await run(updated);

    expect(sent().message).toContain(
      "Retakes auto-updated from 1.1.0 to 1.2.0",
    );
    expect(sent().message).toContain("3 nodes");
  });

  // Changing a pinned version is somebody typing it in. Reporting it back to
  // them is noise, and it is the case the toggle exists to make explicit.
  it("stays quiet about a pinned plugin moving", async () => {
    postgres.query.mockResolvedValueOnce([
      { name: "Retakes", channel: "Pinned" },
    ]);

    await run(updated);

    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("says nothing about a plugin that was uninstalled since", async () => {
    postgres.query.mockResolvedValue([]);

    await run(updated);

    expect(notifications.send).not.toHaveBeenCalled();
  });

  // Which nodes failed, and what they are still running, are the two things an
  // admin needs before deciding whether it can wait.
  it("names the nodes that failed and the version they kept", async () => {
    postgres.query
      .mockResolvedValueOnce([{ name: "Retakes", channel: "Auto" }])
      .mockResolvedValueOnce([
        { game_server_node_id: "node-1", last_error: "digest mismatch" },
        { game_server_node_id: "node-2", last_error: null },
      ]);

    await run(failed);

    expect(sent().message).toContain("node-1, node-2");
    expect(sent().message).toContain("digest mismatch");
    expect(sent().message).toContain("still running 1.1.0");
  });

  // A pinned install failing is just as silent as an auto one, so the channel
  // filter deliberately does not apply here.
  it("reports a pinned install failing too", async () => {
    postgres.query
      .mockResolvedValueOnce([{ name: "Retakes", channel: "Pinned" }])
      .mockResolvedValueOnce([
        { game_server_node_id: "node-1", last_error: "404" },
      ]);

    await run(failed);

    expect(notifications.send).toHaveBeenCalled();
  });

  // converge() retries every five minutes, so by the time this runs the thing
  // it is about to report may have already fixed itself.
  it("drops a failure that recovered while the notice waited", async () => {
    postgres.query
      .mockResolvedValueOnce([{ name: "Retakes", channel: "Auto" }])
      .mockResolvedValueOnce([]);

    await run(failed);

    expect(notifications.send).not.toHaveBeenCalled();
  });
});
