// Shared between ClipsService (producer) and BatchHighlightsRenderJob
// (consumer). Kept in its own file because importing the worker class
// from clips.service triggers a load-time cycle (matches → clips →
// matches via the worker's ClipsService dep).
export const BATCH_HIGHLIGHTS_JOB_NAME = "BatchHighlightsRenderJob";

export const IN_FLIGHT_STATUSES = ["queued", "rendering", "uploading"] as const;

export type ClipRenderStatus =
  | (typeof IN_FLIGHT_STATUSES)[number]
  | "done"
  | "error"
  | "cancelled";

export const TERMINAL_STATUSES = ["done", "error", "cancelled"] as const;

export function resolveInClusterApiBase(): string {
  return process.env.API_INTERNAL_BASE ?? "http://api:5585";
}
