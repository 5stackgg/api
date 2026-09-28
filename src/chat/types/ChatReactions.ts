// Reaction id to the steam ids that reacted with it, oldest first. A reaction
// nobody holds is left out rather than sent as an empty list.
export type ChatReactions = Record<string, string[]>;
