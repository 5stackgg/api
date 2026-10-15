export interface ChatMention {
  // Always a string, like ChatMessage.from.steam_id.
  steam_id: string;
  // The name as the text spells it, which is what a client finds and draws.
  // The steam id is who it is, so a rename afterwards changes neither.
  name: string;
}
