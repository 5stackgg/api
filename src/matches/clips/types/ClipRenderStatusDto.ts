export interface ClipRenderStatusDto {
  status: string;
  progress?: number;
  error?: string;
  duration_ms?: number;
  // Sent with status="booting" — written to status_history only.
  boot_stage?: string;
  boot_progress?: number;
}
