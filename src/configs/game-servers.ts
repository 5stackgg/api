import { GameServersConfig } from "./types/GameServersConfig";

export default (): {
  gameServers: GameServersConfig;
} => ({
  gameServers: {
    serverImage: process.env.SERVER_IMAGE,
    namespace: process.env.SERVER_NAMESPACE,
  },
});
