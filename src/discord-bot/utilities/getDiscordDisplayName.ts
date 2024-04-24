import { CachedDiscordUser } from "../types/CachedDiscordUser";

export function getDiscordDisplayName(user: CachedDiscordUser) {
  return user.globalName || user.username;
}
