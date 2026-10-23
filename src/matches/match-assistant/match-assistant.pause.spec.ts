import { MatchAssistantService } from "./match-assistant.service";

describe("MatchAssistantService setServerPaused", () => {
  const setup = (
    pluginRuntime: string | null,
    deploymentRuntime = "swiftlys2",
  ) => {
    const send = jest.fn(async () => "");
    const rcon = { connect: jest.fn(async () => ({ send })) };
    const hasura = {
      query: jest.fn(async () => ({
        matches_by_pk: {
          server: { id: "server-1", plugin_runtime: pluginRuntime },
        },
      })),
    };
    const pluginRuntimeService = {
      getPluginRuntime: jest.fn(async () => deploymentRuntime),
    };

    const service = new MatchAssistantService(
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
      rcon as any,
      {} as any,
      { get: jest.fn(() => ({ namespace: "test" })) } as any,
      hasura as any,
      {} as any,
      {} as any,
      pluginRuntimeService as any,
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
      const { service, send, rcon } = setup(runtime);

      await service.setServerPaused("match-1", paused);

      expect(rcon.connect).toHaveBeenCalledWith("server-1");
      expect(send.mock.calls).toEqual([[command]]);
    },
  );

  it.each([
    ["counterstrikesharp", "css_pause"],
    ["swiftlys2", "sw_pause"],
  ])(
    "uses the deployment's runtime, %s, for a server that has not reported one",
    async (deploymentRuntime, command) => {
      const { service, send } = setup(null, deploymentRuntime);

      await service.setServerPaused("match-1", true);

      expect(send.mock.calls).toEqual([[command]]);
    },
  );
});
