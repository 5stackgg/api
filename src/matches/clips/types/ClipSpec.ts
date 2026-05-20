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
  // Chip-display fields (game-streamer bakes them when CLIP_BAKE_BRANDING=1).
  target_name?: string;
  target_avatar_url?: string;
  map_name?: string;
  round?: number;
  kills_count?: number;
  visibility?: "private" | "unlisted" | "public" | "match";
}
