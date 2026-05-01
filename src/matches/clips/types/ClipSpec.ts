// Server-side mirror of the web `ClipSpec` (graphql/clipRenderJob.ts).
// Hasura passes the input through unchanged from the actions.graphql
// schema; the api validates the segments + output before spawning a
// pod and stores the spec verbatim on the clip_render_jobs row.
export interface ClipSpec {
  match_map_id: string;
  segments: Array<{
    start_tick: number;
    end_tick: number;
    speed?: number;
    pov_steam_id?: string;
  }>;
  overlays?: Array<{
    type: string;
    start_ms: number;
    end_ms: number;
    payload?: Record<string, unknown>;
  }>;
  audio?: {
    track_url?: string;
    volume?: number;
    fade_in_ms?: number;
    fade_out_ms?: number;
    duck_game_audio?: boolean;
  };
  output: {
    format: "mp4";
    resolution: "720p" | "1080p";
    fps: number;
  };
  destination: "library" | "download";
  title?: string;
}
