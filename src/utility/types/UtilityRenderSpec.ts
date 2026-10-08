// The job payload the render pod reads. Key names are the game-streamer's
// contract (src/lib/clip-helpers.mjs `nade-fields`), which mirrors the
// utility_lineups column names -- so a row splats into it.
export interface UtilityRenderSpec {
  // What the pod stages by (`/render_stage <lineup_id>`).
  lineup_id: string;
  lineup_name: string;
  map_name: string;
  nade_type: string;
  side: string;

  origin_x: number;
  origin_y: number;
  origin_z: number;
  eye_z: number | null;
  view_yaw: number;
  view_pitch: number;

  // How the pod acts the throw out; the flight itself is the seed's.
  technique: string;
  throw_strength: string | null;
  jump_throw_bind: boolean;

  land_x: number;
  land_y: number;
  land_z: number;

  flight_time_ms: number | null;
  confidence: string;

  // Stamped at dispatch, not at enqueue: it is a fact about the practice
  // server that ends up filming this, and no server is picked until then.
  plugin_runtime?: string | null;

  // The pod re-derives this from the six initial_* values when we do not state
  // it. We state it, because the api already knows whether the seed is
  // complete and a lineup without one is skipped rather than approximated.
  has_seed: boolean;
  initial_pos_x?: number | null;
  initial_pos_y?: number | null;
  initial_pos_z?: number | null;
  initial_vel_x?: number | null;
  initial_vel_y?: number | null;
  initial_vel_z?: number | null;

  output: {
    resolution: "720p" | "1080p";
    fps: number;
  };
}
