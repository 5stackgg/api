import { GameServersConfig } from "./types/GameServersConfig";

export default (): {
  gameServers: GameServersConfig;
} => ({
  gameServers: {
    serverDomain: process.env.SERVER_DOMAIN,
    serverImage: process.env.SERVER_IMAGE,
    namespace: process.env.SERVER_NAMESPACE,
    portRange: (process.env.SERVER_PORT_RANGE || "30000:30085").split(":") as [
      string,
      string
    ],
    defaultRconPassword: process.env.DEFAULT_RCON_PASSWORD,
    csUsername: process.env.CS_USERNAME,
    csPassword: process.env.CS_PASSWORD,
  },
});
