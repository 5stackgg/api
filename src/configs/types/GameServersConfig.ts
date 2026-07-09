export const PLUGIN_RUNTIMES = ["swiftlys2", "counterstrikesharp"] as const;

export type PluginRuntime = (typeof PLUGIN_RUNTIMES)[number];

export const DEFAULT_PLUGIN_RUNTIME: PluginRuntime = "swiftlys2";

export const isPluginRuntime = (
  value?: string | null,
): value is PluginRuntime => PLUGIN_RUNTIMES.includes(value as PluginRuntime);

export type GameServersConfig = {
  namespace: string;
  serverImageOverride: string | null;
  pluginRuntimeImages: Record<PluginRuntime, string>;
  gameStreamerImage: string;
};
