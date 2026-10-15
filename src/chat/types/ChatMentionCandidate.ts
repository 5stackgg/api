export interface ChatMentionCandidate {
  steam_id: string;
  name: string;
  avatar_url: string | null;
  // Their team in this room, where the room has teams.
  team: string | null;
  organizer: boolean;
}
