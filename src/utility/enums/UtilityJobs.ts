// The queue processor resolves a job to its class by name, so these must match
// the class names exactly.
export const UtilityJobs = {
  ReapIdleUtilityPracticeSessions: `ReapIdleUtilityPracticeSessions`,
  MineUtilityMeta: `MineUtilityMeta`,
  RunUtilityDriftScan: `RunUtilityDriftScan`,
  BatchUtilityRenderJob: `BatchUtilityRenderJob`,
} as const;
