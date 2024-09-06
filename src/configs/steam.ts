import { SteamConfig } from "./types/SteamConfig";

export default (): {
  steam: SteamConfig;
} => ({
  steam: {
    steamApiKey: process.env.CS_AUTH_KEY,
    steamAccount: process.env.STEAM_ACCOUNT,
    serverAccount: process.env.SERVER_ACCOUNT,
    serverAccountPassword: process.env.SERVER_ACCOUNT_PASSWORD,
  },
});
