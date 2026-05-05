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
