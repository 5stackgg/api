export interface GameStreamerStatusDto {
  status: string;
  stream_url?: string;
  error?: string;
  // 0..100. The bash report_status helper json-encodes everything as a
  // string, so we accept either and coerce in the service.
  progress?: number | string;
  progress_stage?: string;
}
