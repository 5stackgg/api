export const PLUGIN_RUNTIMES = ["swiftlys2", "counterstrikesharp"] as const;

export type PluginRuntime = (typeof PLUGIN_RUNTIMES)[number];

export const DEFAULT_PLUGIN_RUNTIME: PluginRuntime = "swiftlys2";

// The utility practice plugin only ships for SwiftlyS2, and the
// CounterStrikeSharp image refuses to boot a practice server.
export const PRACTICE_PLUGIN_RUNTIME: PluginRuntime = "swiftlys2";

export const isPluginRuntime = (
  value?: string | null,
): value is PluginRuntime => PLUGIN_RUNTIMES.includes(value as PluginRuntime);

export type GameServersConfig = {
  namespace: string;
  serverImageOverride: string | null;
  pluginRuntimeImages: Record<PluginRuntime, string>;
  gameStreamerImage: string;
  utilityRenderStreamerImage: string | null;
  utilityRenderServerImage: string | null;
};
