export type SanctionType = "ban" | "mute" | "gag" | "silence" | "warning";

// Also the only types the public record counts: a warning is private to the
// player and staff. Lives outside SanctionsService so the search index can read
// it without importing rcon, which already imports the search service.
export const SERVER_ENFORCED_SANCTION_TYPES: SanctionType[] = [
  "ban",
  "mute",
  "gag",
  "silence",
];
