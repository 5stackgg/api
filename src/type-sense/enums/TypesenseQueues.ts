export enum TypesenseQueues {
  "TypeSense" = "type-sense",
  PlayerReindex = "player-reindex",
  NadeLineupReindex = "nade-lineup-reindex",
}

// Held as a literal rather than RefreshAllNadeLineupsJob.name: the job
// injects TypeSenseService, so importing the class back into the service is a
// cycle and Nest resolves one side to undefined at construction.
export const NADE_LINEUP_REINDEX_JOB = "RefreshAllNadeLineupsJob";
