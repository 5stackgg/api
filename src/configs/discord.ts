import { DiscordConfig } from "./types/DiscordConfig";

export default (): {
  discord: DiscordConfig;
} => ({
  discord: {
    token: process.env.DISCORD_BOT_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
  },
});
