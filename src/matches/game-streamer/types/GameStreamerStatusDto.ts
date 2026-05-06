export interface GameStreamerStatusDto {
  status: string;
  stream_url?: string;
  error?: string;
  // 0..100; bash sends as string, coerced in the service.
  progress?: number | string;
  progress_stage?: string;
}
