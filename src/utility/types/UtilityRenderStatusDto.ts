// Everything nade-clip.sh / batch-nades.sh / status-reporter.sh can post to
// /nade-renders/:jobId/status. Only `progress`, `duration_ms` and
// `boot_progress` arrive as numbers (clip-helpers.mjs coerces exactly those);
// the rest are strings.
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
  // Sent with status="booting" by status-reporter.sh's batch broadcast -- the
  // pod's own boot stages (downloading_cs2, launching_steam, ...). Written to
  // status_history only; a boot tick never touches row.status.
  boot_stage?: string;
  boot_progress?: number;
  // One-shot milestone raised alongside the boot. Honouring the flag keeps a
  // direct post from putting an off-enum value in `status`.
  event?: boolean | string;
}
