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
  // Player this clip is "about" — set by buildPresetSpec so the queue
  // UI can show the player attribution as a separate meta line. Pre-
  // resolved from the demo's parsed players or the players table at
  // enqueue time; the streamer pod's GSI title patch can refine it
  // mid-render if the demo had a stale name.
  target_name?: string;
  // Visibility the resulting match_clips row should land with. The
  // auto-clip flow stamps this from the `auto_clip_default_visibility`
  // setting at queue time so finalizeClipUpload doesn't have to look
  // the setting up again on every render. Manual renders can leave
  // this unset; finalizeClipUpload defaults to "private".
  visibility?: "private" | "unlisted" | "public" | "match";
}
