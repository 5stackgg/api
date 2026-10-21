// The queue processor resolves a job to its class by name, so these must match
// the class names exactly.
export const UtilityJobs = {
  ReapIdleUtilityPracticeSessions: `ReapIdleUtilityPracticeSessions`,
  ReconcileUtilitySessions: `ReconcileUtilitySessions`,
  MineUtilityMeta: `MineUtilityMeta`,
  SyncMapCallouts: `SyncMapCallouts`,
  RunUtilityDriftScan: `RunUtilityDriftScan`,
  BatchUtilityRenderJob: `BatchUtilityRenderJob`,
  RunUtilityDiscovery: `RunUtilityDiscovery`,
} as const;
