export interface GameStreamerStatusDto {
  status: string;
  stream_url?: string;
  error?: string;
  // 0..100; bash sends as string, coerced in the service.
  progress?: number | string;
  progress_stage?: string;
  // One-shot milestone (e.g. demo_ready) raised by a worker running
  // alongside the main boot: appended to status_history only, `status`
  // is left on whatever the boot is actually doing.
  event?: boolean | string;
}
