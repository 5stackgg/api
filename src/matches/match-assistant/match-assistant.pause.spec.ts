import { MatchAssistantService } from "./match-assistant.service";
import { PluginRuntimeService } from "src/plugin-runtime/plugin-runtime.service";

type ServerRow = {
  plugin_runtime: string | null;
  game_server_node?: { pin_plugin_runtime: string | null } | null;
};

describe("MatchAssistantService setServerPaused", () => {
  const setup = (server: ServerRow, deploymentRuntime = "swiftlys2") => {
    const send = jest.fn(async () => "");
    const rcon = { connect: jest.fn(async () => ({ send })) };
    const row: ServerRow & { id: string } = {
      id: "server-1",
      game_server_node: null,
      ...server,
    };
    const hasura = {
      query: jest.fn(async () => ({ matches_by_pk: { server: row } })),
    };
    const pluginRuntimeService = new PluginRuntimeService(
      {} as any,
      { query: jest.fn(async () => [{ value: deploymentRuntime }]) } as any,
    );

    const service = new MatchAssistantService(
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
      rcon as any,
      {} as any,
      { get: jest.fn(() => ({ namespace: "test" })) } as any,
      hasura as any,
      {} as any,
      {} as any,
      pluginRuntimeService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service, send, rcon };
  };

  it.each([
    ["counterstrikesharp", true, "css_pause"],
    ["counterstrikesharp", false, "css_resume"],
    ["swiftlys2", true, "sw_pause"],
    ["swiftlys2", false, "sw_resume"],
  ])(
    "sends a %s server only the plugin's own command for paused=%s",
    async (runtime, paused, command) => {
      const { service, send, rcon } = setup({ plugin_runtime: runtime });

      await service.setServerPaused("match-1", paused);

      expect(rcon.connect).toHaveBeenCalledWith("server-1");
      expect(send.mock.calls).toEqual([[command]]);
    },
  );

  it("goes by the runtime the server reports over its node's pin", async () => {
    const { service, send } = setup({
      plugin_runtime: "swiftlys2",
      game_server_node: { pin_plugin_runtime: "counterstrikesharp" },
    });

    await service.setServerPaused("match-1", true);

    expect(send.mock.calls).toEqual([["sw_pause"]]);
  });

  it("uses its node's pinned runtime for a server that has not reported one", async () => {
    const { service, send } = setup(
      {
        plugin_runtime: null,
        game_server_node: { pin_plugin_runtime: "counterstrikesharp" },
      },
      "swiftlys2",
    );

    await service.setServerPaused("match-1", true);

    expect(send.mock.calls).toEqual([["css_pause"]]);
  });

  it.each([
    ["counterstrikesharp", "css_pause"],
    ["swiftlys2", "sw_pause"],
  ])(
    "uses the deployment's runtime, %s, for an unpinned server that has not reported one",
    async (deploymentRuntime, command) => {
      const { service, send } = setup(
        { plugin_runtime: null },
        deploymentRuntime,
      );

      await service.setServerPaused("match-1", true);

      expect(send.mock.calls).toEqual([[command]]);
    },
  );
});
