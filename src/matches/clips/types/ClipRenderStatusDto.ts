// Posted by the render pod's status reporter daemon. Mirrors
// GameStreamerStatusDto for the demo flow but adds `progress` (wallclock
// fraction 0..1) so the editor can show a determinate bar instead of a
// busy spinner.
export interface ClipRenderStatusDto {
  status: string;
  progress?: number;
  error?: string;
  // Filled by the pod once ffprobe runs on the rendered file. Used so
  // the match_clips row that this status row will be promoted into has
  // a duration without the api needing to inspect the upload.
  duration_ms?: number;
}
