import { SteamConfig } from "./types/SteamConfig";

export default (): {
  steam: SteamConfig;
} => ({
  steam: {
    steamApiKey: process.env.STEAM_WEB_API_KEY,
    steamUser: process.env.STEAM_USER,
    steamPassword: process.env.STEAM_PASSWORD,
  },
});
