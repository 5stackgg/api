import { GameServersConfig } from "./types/GameServersConfig";

export default (): {
  gameServers: GameServersConfig;
} => ({
  gameServers: {
    // The runtime is picked in application settings. SERVER_IMAGE remains an
    // escape hatch for custom or mirrored images and takes precedence over it.
    serverImageOverride: process.env.SERVER_IMAGE || null,
    pluginRuntimeImages: {
      swiftlys2: "ghcr.io/5stackgg/swiftly-game-server",
      counterstrikesharp: "ghcr.io/5stackgg/game-server",
    },
    gameStreamerImage:
      process.env.GAME_STREAMER_IMAGE ||
      "ghcr.io/5stackgg/game-streamer:latest",
    namespace: "5stack",
  },
});
