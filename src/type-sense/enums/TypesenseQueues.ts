export enum TypesenseQueues {
  "TypeSense" = "type-sense",
  PlayerReindex = "player-reindex",
  UtilityLineupReindex = "utility-lineup-reindex",
}

// Held as a literal rather than RefreshAllUtilityLineupsJob.name: the job
// injects TypeSenseService, so importing the class back into the service is a
// cycle and Nest resolves one side to undefined at construction.
export const UTILITY_LINEUP_REINDEX_JOB = "RefreshAllUtilityLineupsJob";
