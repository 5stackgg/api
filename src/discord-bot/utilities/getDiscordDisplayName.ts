import { User } from "discord.js";

export function getDiscordDisplayName(user: User) {
  return user.globalName || user.username;
}
