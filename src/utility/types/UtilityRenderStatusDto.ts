// Everything nade-clip.sh / batch-nades.sh can post to
// /nade-renders/:jobId/status. Only `progress` and `duration_ms` arrive as
// numbers (clip-helpers.mjs coerces exactly those two); the rest are strings.
export interface UtilityRenderStatusDto {
  status: string;
  progress?: number;
  error?: string;
  duration_ms?: number;
  // Set instead of `error` when the pod refuses a lineup it cannot reproduce
  // exactly. Kept apart because it is a verdict on the lineup, not a fault.
  skip_reason?: string;
  // "1" when the clip's timing came from the recorded flight time rather than
  // an observed detonation (NADE_ALLOW_TIMED_DETONATION).
  unverified_timing?: boolean | string;
}
