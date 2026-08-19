// The queue processor resolves a job to its class by name, so these must match
// the class names exactly.
export const NadeJobs = {
  ReapIdleNadePracticeSessions: `ReapIdleNadePracticeSessions`,
  MineNadeMeta: `MineNadeMeta`,
  RunNadeDriftScan: `RunNadeDriftScan`,
} as const;
