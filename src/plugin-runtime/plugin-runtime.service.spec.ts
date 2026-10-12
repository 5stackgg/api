import { PluginRuntimeService } from "./plugin-runtime.service";

// The CounterStrikeSharp image refuses to boot a practice server, so practice
// runs SwiftlyS2 whatever the install picked for matches -- and the two
// runtimes number their releases separately, so only a SwiftlyS2 pin means
// anything to it.
describe("PluginRuntimeService practice servers", () => {
  const build = (
    options: {
      activeRuntime?: string;
      serverImageOverride?: string | null;
      supported?: boolean;
    } = {},
  ) => {
    const seen: Array<{ sql: string; params: Array<unknown> }> = [];

    const postgres = {
      query: jest.fn(async (sql: string, params: Array<unknown> = []) => {
        seen.push({ sql, params });

        if (sql.includes("FROM public.settings")) {
          return [{ value: options.activeRuntime ?? "swiftlys2" }];
        }
        if (sql.includes("game_version_supports_plugin")) {
          return [{ supported: options.supported ?? true }];
        }
        return [];
      }),
    };

    const service = new PluginRuntimeService(
      {
        get: jest.fn(() => ({
          serverImageOverride: options.serverImageOverride ?? null,
          pluginRuntimeImages: {
            swiftlys2: "ghcr.io/5stackgg/game-server-sw",
            counterstrikesharp: "ghcr.io/5stackgg/game-server-css",
          },
        })),
      } as never,
      postgres as never,
    );

    const supportsCall = () =>
      seen.find((entry) => entry.sql.includes("game_version_supports_plugin"));

    return { service, supportsCall };
  };

  describe("resolvePracticeServerImage", () => {
    it("honours a pin made against SwiftlyS2", async () => {
      const { service } = build({ activeRuntime: "counterstrikesharp" });

      await expect(
        service.resolvePracticeServerImage({
          pin_plugin_version: "0.1.4",
          pin_plugin_runtime: "swiftlys2",
        }),
      ).resolves.toBe("ghcr.io/5stackgg/game-server-sw:v0.1.4");
    });

    it("honours an unlabelled pin while the install runs SwiftlyS2", async () => {
      const { service } = build({ activeRuntime: "swiftlys2" });

      await expect(
        service.resolvePracticeServerImage({
          pin_plugin_version: "0.1.4",
          pin_plugin_runtime: null,
        }),
      ).resolves.toBe("ghcr.io/5stackgg/game-server-sw:v0.1.4");
    });

    it("ignores a CounterStrikeSharp pin and takes the latest SwiftlyS2 build", async () => {
      const { service } = build({ activeRuntime: "swiftlys2" });

      await expect(
        service.resolvePracticeServerImage({
          pin_plugin_version: "0.0.90",
          pin_plugin_runtime: "counterstrikesharp",
        }),
      ).resolves.toBe("ghcr.io/5stackgg/game-server-sw:latest");
    });

    it("ignores an unlabelled pin while the install runs CounterStrikeSharp", async () => {
      const { service } = build({ activeRuntime: "counterstrikesharp" });

      await expect(
        service.resolvePracticeServerImage({
          pin_plugin_version: "0.0.90",
          pin_plugin_runtime: null,
        }),
      ).resolves.toBe("ghcr.io/5stackgg/game-server-sw:latest");
    });

    it("runs SwiftlyS2 on an unpinned node of a CounterStrikeSharp install", async () => {
      const { service } = build({ activeRuntime: "counterstrikesharp" });

      await expect(
        service.resolvePracticeServerImage({
          pin_plugin_version: null,
          pin_plugin_runtime: null,
        }),
      ).resolves.toBe("ghcr.io/5stackgg/game-server-sw:latest");
    });

    it("still lets SERVER_IMAGE override it", async () => {
      const { service } = build({
        serverImageOverride: "registry.local/game-server:dev",
      });

      await expect(service.resolvePracticeServerImage()).resolves.toBe(
        "registry.local/game-server:dev",
      );
      await expect(
        service.resolvePracticeServerImage({
          pin_plugin_version: "0.1.4",
          pin_plugin_runtime: "swiftlys2",
        }),
      ).resolves.toBe("registry.local/game-server:v0.1.4");
    });
  });

  describe("supportsPractice", () => {
    it("asks about the SwiftlyS2 pin, on SwiftlyS2", async () => {
      const { service, supportsCall } = build();

      await expect(
        service.supportsPractice({
          build_id: 20000,
          pin_plugin_version: "0.1.4",
          pin_plugin_runtime: "swiftlys2",
        }),
      ).resolves.toBe(true);

      expect(supportsCall()?.params).toEqual([20000, "0.1.4", "swiftlys2"]);
    });

    it("asks about the latest SwiftlyS2 release for a CounterStrikeSharp pin", async () => {
      const { service, supportsCall } = build();

      await service.supportsPractice({
        build_id: 20000,
        pin_plugin_version: "0.0.90",
        pin_plugin_runtime: "counterstrikesharp",
      });

      expect(supportsCall()?.params).toEqual([20000, null, "swiftlys2"]);
    });

    it("refuses a build SwiftlyS2 does not support yet", async () => {
      const { service } = build({ supported: false });

      await expect(
        service.supportsPractice({
          build_id: 20000,
          pin_plugin_version: null,
          pin_plugin_runtime: null,
        }),
      ).resolves.toBe(false);
    });

    it("lets a node that has not reported a build through", async () => {
      const { service, supportsCall } = build({ supported: false });

      await expect(service.supportsPractice({ build_id: null })).resolves.toBe(
        true,
      );
      expect(supportsCall()).toBeUndefined();
    });
  });
});
