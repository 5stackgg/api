import { GameServersConfig } from "./types/GameServersConfig";

export default (): {
  gameServers: GameServersConfig;
} => ({
  gameServers: {
    serverImage:
      process.env.SERVER_IMAGE || "ghcr.io/5stackgg/game-server:latest",
    gameStreamerImage:
      process.env.GAME_STREAMER_IMAGE ||
      "ghcr.io/5stackgg/game-streamer:latest",
    namespace: "5stack",
  },
});
