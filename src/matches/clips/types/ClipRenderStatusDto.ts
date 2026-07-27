export interface ClipRenderStatusDto {
  status: string;
  progress?: number;
  error?: string;
  duration_ms?: number;
  // Sent with status="booting" — written to status_history only.
  boot_stage?: string;
  boot_progress?: number;
  // One-shot milestone (e.g. demo_ready) raised alongside the boot. Batch
  // pods already fold these into status="booting" on the wire; honouring the
  // flag here keeps a direct post from putting an off-enum value in `status`.
  event?: boolean | string;
}
