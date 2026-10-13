import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Service } from "../s3/s3.service";
import { AppConfig } from "../configs/types/AppConfig";
import { UtilitySmokeVoxelCapture } from "../utility/types/UtilitySmokeVoxelCapture";

export type ParsedRound = {
  round: number;
  start_tick: number;
  end_tick: number;
  winner?: string;
  reason?: number;
  ct_money?: number;
  t_money?: number;
};

export type ParsedKill = {
  tick: number;
  killer?: string;
  victim?: string;
  assist?: string;
  assist_flash?: boolean;
  killer_team?: string;
  victim_team?: string;
  weapon?: string;
  headshot?: boolean;
  wallbang?: boolean;
  noscope?: boolean;
  smoke?: boolean;
  attacker_x?: number;
  attacker_y?: number;
  attacker_z?: number;
  victim_x?: number;
  victim_y?: number;
  victim_z?: number;
};

export type ParsedBomb = {
  tick: number;
  type:
    | "planted"
    | "defused"
    | "exploded"
    | "plant_begin"
    | "plant_abort"
    | "defuse_begin"
    | "defuse_abort"
    | "dropped"
    | "pickup";
  player?: string;
  site?: "A" | "B";
  has_kit?: boolean;
  x?: number;
  y?: number;
  z?: number;
};

export type ParsedKitDrop = {
  tick: number;
  round?: number;
  player?: string;
  x: number;
  y: number;
  z: number;
};

export type ParsedPlayer = {
  steam_id: string;
  name: string;
  starting_side?: string;
  rank?: number;
  rank_type?: number;
  previous_rank?: number;
  win_count?: number;
};

export type ParsedShotFired = {
  tick: number;
  round?: number;
  attacker?: string;
  attacker_team?: string;
  weapon?: string;
  speed?: number;
  counter_strafed?: boolean;
  crosshair_angle_deg?: number;
  ammo_in_magazine?: number;
  // Exact firing geometry + outcome (for the 3D replay tracer).
  yaw?: number;
  pitch?: number;
  eye_x?: number;
  eye_y?: number;
  eye_z?: number;
  result?: "hit" | "headshot";
  impact_x?: number;
  impact_y?: number;
  impact_z?: number;
  // Where a missed round met world geometry, raycast against the map's
  // collision mesh. Absent on maps with no mesh, or when the shot found nothing.
  miss_x?: number;
  miss_y?: number;
  miss_z?: number;
};

export type ParsedPosition = {
  tick: number;
  round?: number;
  attacker?: string;
  team?: string;
  alive?: boolean;
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  health?: number;
  armor?: number;
  helmet?: boolean;
  has_bomb?: boolean;
  has_defuser?: boolean;
  active_weapon?: string;
  // The engine's FL_DUCKING flag. A crouch still animating reads as standing.
  // Stance moves the release point by ~18 units, so a lineup mined out of a
  // demo cannot state its own technique without it.
  ducked?: boolean;
};

// Per-engagement aim metrics emitted by the parser; consumed only by
// persist_parsed_demo (not part of the playback blob).
export type ParsedAimEngagement = {
  attacker?: string;
  round?: number;
  first_shot_fired?: boolean;
  first_shot_hit?: boolean;
  on_target_frames?: number;
  total_frames?: number;
  weapon_class?: string;
};

export type ParsedRoundInventory = {
  round?: number;
  attacker?: string;
  team?: string;
  flash?: number;
  smoke?: number;
  he?: number;
  molotov?: number;
  decoy?: number;
  primary?: string;
  secondary?: string;
  armor?: number;
  helmet?: boolean;
  kit?: boolean;
};

export type ParsedDamageEvent = {
  tick: number;
  round?: number;
  attacker?: string;
  victim?: string;
  attacker_team?: string;
  victim_team?: string;
  weapon?: string;
  damage: number;
  damage_armor?: number;
  hitgroup?: number;
  health?: number;
  since_round_start?: number;
};

export type ParsedSpotted = {
  tick: number;
  round?: number;
  spotter?: string;
  spotted?: string;
  spotter_team?: string;
};

// Grenade events come in two flavors with the same shape — distinguished by
// `phase`. Throw rows always carry a thrower; detonate rows for molotov /
// incendiary will have an empty thrower because CS2 demos null it out on
// FireGrenadeStart (api-side attribution joins back to the prior throw).
export type ParsedGrenadeEvent = {
  tick: number;
  round?: number;
  gid?: number;
  thrower?: string;
  thrower_team?: string;
  type: "Flash" | "HE" | "Smoke" | "Molotov" | "Decoy";
  ox?: number;
  oy?: number;
  oz?: number;
  x?: number;
  y?: number;
  z?: number;
};

// One smoke's density grid, derived by the parser from the map's collision mesh
// rather than assumed to be a sphere. `den` is base64, two cells per byte with
// the low nibble first, over dx*dy*dz cells, x-major then y then z: cell
// (i,j,k) is at index (k*dy + j)*dx + i and has its minimum corner at
// (ox,oy,oz) + (i,j,k)*vs, in source units. 0 is clear, 15 is fully dense.
export type ParsedSmokeVolume = {
  gid?: number;
  round?: number;
  start_tick: number;
  end_tick?: number;
  ox: number;
  oy: number;
  oz: number;
  vs: number;
  dx: number;
  dy: number;
  dz: number;
  den?: string;
};

// One smoke as the game itself simulated it, rebuilt by the parser from the
// voxel log CS2 networks on the projectile. `arr` is base64, one byte per cell
// over dx*dy*dz cells, x fastest, then y, then z: cell (i,j,k) is at index
// (k*dy + j)*dx + i and has its minimum corner at (ox,oy,oz) + (i,j,k)*vs. A
// byte is when the cell filled after detonation in 1/40 s (0-254), or 255 for
// a cell the smoke never reached.
export type ParsedSmokeVoxels = {
  gid: number;
  round: number;
  start_tick: number;
  end_tick: number;
  ox: number;
  oy: number;
  oz: number;
  vs: number;
  dx: number;
  dy: number;
  dz: number;
  arr: string;
};

// What POST /smoke-volume answers with: the same EventSmokeVolume the playback
// blob carries, inline, plus the two numbers only the standalone endpoint knows.
export type ParsedSmokeVolumeResponse = ParsedSmokeVolume & {
  map?: string;
  cells?: number;
  radius?: number;
};

export type ParsedGeometryPoint = { x: number; y: number; z: number };

// One end-to-end line to test. Both ends are eye positions for /sightlines and
// feet positions for /oneway (which derives the eyes from stance itself).
export type ParsedSightlinePair = {
  from: ParsedGeometryPoint;
  to: ParsedGeometryPoint;
};

// A cloud, named either by the point it blooms from or by a grid already
// computed. Supplying the grid skips the flood, which is the expensive half.
export type ParsedCloudSpec = {
  at?: ParsedGeometryPoint;
  volume?: ParsedSmokeVolume;
};

export type ParsedSightlineRequest = {
  map: string;
  pairs: Array<ParsedSightlinePair>;
  smokes?: Array<ParsedCloudSpec>;
  threshold?: number;
};

export type ParsedSightlineResult = {
  blocked: boolean;
  blocked_by?: string;
  world_blocked: boolean;
  depth: number;
  transmittance: number;
  // One entry per cloud in the request, in the order they were sent. This is
  // what makes a batched "which of these smokes closes this angle" answerable
  // in one call instead of one call per candidate.
  per_smoke?: Array<number>;
  distance: number;
};

export type ParsedSightlineResponse = {
  map?: string;
  threshold: number;
  smokes?: Array<{
    center: ParsedGeometryPoint;
    model: string;
    cells?: number;
    radius: number;
    sealed?: boolean;
  }>;
  results: Array<ParsedSightlineResult>;
};

export type ParsedOneWayRequest = {
  map: string;
  pairs: Array<ParsedSightlinePair>;
  smokes?: Array<ParsedCloudSpec>;
  positions?: "feet" | "eyes";
  threshold?: number;
};

export type ParsedOneWayResult = {
  one_way: boolean;
  favors?: string;
  cause?: string;
  confidence: string;
  contested?: boolean;
};

export type ParsedOneWayResponse = {
  map?: string;
  threshold: number;
  results: Array<ParsedOneWayResult>;
  caveats?: Array<string>;
};

// One stored lineup as /drift wants it. `utility_type` uses the parser's own
// spellings, which are not this database's -- translate it with
// DemoParserService.parserUtilityType() rather than passing the column through.
export type ParsedDriftLineup = {
  id: string;
  utility_type: string;
  initial_position?: ParsedGeometryPoint;
  initial_velocity?: ParsedGeometryPoint;
};

export type ParsedDriftRequest = {
  map: string;
  from?: string;
  to?: string;
  lineups: Array<ParsedDriftLineup>;
  unchanged_radius?: number;
  major_radius?: number;
};

export type ParsedDriftVerdict =
  | "unchanged"
  | "moved"
  | "broken"
  | "unsimulatable";

export type ParsedDriftResult = {
  index: number;
  id?: string;
  verdict: ParsedDriftVerdict;
  reason?: string;
  severity?: string;
  distance?: number;
  distance_xy?: number;
  distance_z?: number;
};

export type ParsedDriftResponse = {
  map?: string;
  from?: string;
  to?: string;
  thresholds?: { unchanged: number; major: number };
  summary?: {
    lineups: number;
    unchanged: number;
    moved: number;
    broken: number;
    unsimulatable: number;
    max_distance: number;
  };
  results?: Array<ParsedDriftResult>;
  caveats?: Array<string>;
};

// Every geometry endpoint can answer "not on this map" (404), "that point is
// inside a wall" (422) or "busy" (503), and none of those is this API failing.
// The error travels with the result so a caller can degrade with a reason
// instead of throwing. A null `data` is the failure; `status` is null when the
// parser was never reached at all.
export type DemoParserResult<T> = {
  data: T | null;
  status: number | null;
  error: string | null;
};

// One molotov or incendiary burn. Flame positions come straight off the demo —
// the engine networks each flame individually — so this is the exact ground the
// fire denied and exactly when, including flames a smoke put out early.
export type ParsedInferno = {
  id: number;
  round?: number;
  thrower?: string;
  thrower_team?: string;
  start_tick: number;
  end_tick?: number;
  fires?: Array<{ x: number; y: number; z: number; s: number; e: number }>;
};

// Asks the parser to build the demo's playback blob (the document the 2D/3D
// replay reads) for this match map, at the blob version this api reads. A
// parser that builds a different version ignores it and returns the full
// parse, which the api then builds the blob from itself.
export type PlaybackRequest = {
  match_map_id: string;
  schema_version: number;
};

// The blob the parser built: gzipped JSON, base64 on the wire, plus the counts
// the api logs for it. When present, the parse left out what only the blob
// needed (positions, grenade trajectories, smoke volumes and voxels,
// infernos, kit drops).
export type ParsedPlayback = {
  schema_version: number;
  match_map_id: string;
  blob: string;
  positions: number;
  shots_fired: number;
  grenade_events: number;
  smoke_volumes: number;
  smoke_voxels: number;
  infernos: number;
  damages: number;
  flashes: number;
};

export type ParsedDemo = {
  // The PARSER's own contract version, not the playback blob's
  // (DEMO_METADATA_VERSION). Different numbers for different things: this one
  // says what the parser emits, that one says what we store. Absent on a
  // response from a parser older than the constant.
  schema_version?: number;
  total_ticks: number;
  tick_rate: number;
  map_name?: string;
  workshop_id?: string;
  cs2_build?: string;
  // Whether the parser had the map's collision mesh, so its sightline-gated
  // stats were checked against the world rather than estimated.
  geometry_validated?: boolean;
  playback?: ParsedPlayback;
  // Match-type signals from the demo's game rules.
  server_name?: string;
  max_rounds?: number;
  overtime_enabled?: boolean;
  player_count?: number;
  game_type?: number;
  game_mode?: number;
  round_ticks: ParsedRound[];
  kills: ParsedKill[];
  bombs: ParsedBomb[];
  players?: ParsedPlayer[];
  shots_fired?: ParsedShotFired[];
  round_inventory?: ParsedRoundInventory[];
  positions?: ParsedPosition[];
  damages?: ParsedDamageEvent[];
  aim_engagements?: ParsedAimEngagement[];
  spotted?: ParsedSpotted[];
  grenade_throws?: ParsedGrenadeEvent[];
  grenade_detonations?: ParsedGrenadeEvent[];
  grenade_trajectories?: Array<{
    gid: number;
    pts: Array<{ t: number; x: number; y: number; z: number }>;
  }>;
  smoke_volumes?: ParsedSmokeVolume[];
  smoke_voxels?: ParsedSmokeVoxels[];
  infernos?: ParsedInferno[];
  flashes?: Array<{
    tick: number;
    round?: number;
    attacker?: string;
    attacker_team?: string;
    victim?: string;
    victim_team?: string;
    duration?: number;
    team_flash?: boolean;
  }>;
  kit_drops?: ParsedKitDrop[];
  player_trades?: Array<{
    steam_id: string;
    trade_kill_opportunities: number;
    trade_kill_attempts: number;
    trade_kill_successes: number;
    traded_death_opportunities: number;
    traded_death_attempts: number;
    traded_death_successes: number;
    util_on_death_sum: number;
    deaths: number;
  }>;
};

@Injectable()
export class DemoParserService {
  // The one grenade the parser and e_utility_types disagree about: the parser
  // -- and the simulator behind /drift -- says "HE", this database says
  // "HighExplosive".
  //
  // Both directions live here, on the service that owns the parser's contract,
  // because getting either one wrong fails SILENTLY and in opposite ways: an
  // unmapped throw is dropped on the way in, and an untranslated lineup comes
  // back "unsimulatable" on the way out, which reads as a real answer rather
  // than a bug. It has already been rediscovered twice.
  private static readonly UTILITY_TYPES: Readonly<Record<string, string>> = {
    Flash: "Flash",
    HE: "HighExplosive",
    HighExplosive: "HighExplosive",
    Smoke: "Smoke",
    Molotov: "Molotov",
    Decoy: "Decoy",
  };

  // Parser spelling to e_utility_types. Undefined is the answer for a grenade
  // this database has no name for, and a caller must drop it rather than guess.
  public static utilityType(value: unknown): string | undefined {
    return DemoParserService.UTILITY_TYPES[String(value)];
  }

  // e_utility_types to the spelling the parser and the simulator answer to.
  public static parserUtilityType(value: unknown): string {
    return String(value) === "HighExplosive" ? "HE" : String(value);
  }

  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly s3: S3Service,
  ) {
    this.appConfig = this.config.get<AppConfig>("app");
  }

  public async parseFromS3Key(
    s3Key: string,
    matchMapDemoId?: string,
    playback?: PlaybackRequest,
  ): Promise<ParsedDemo> {
    const presignedUrl = await this.s3.getPresignedUrl(
      s3Key,
      undefined,
      60 * 30,
      "get",
    );

    this.logger.log(
      `[demo-parser] POST ${this.appConfig.demoParserUrl}/parse (s3_key=${s3Key}${matchMapDemoId ? ` id=${matchMapDemoId}` : ""})`,
    );

    const startedAt = Date.now();
    const res = await this.postParse(presignedUrl, matchMapDemoId, playback);
    const respondedAt = Date.now();

    const parsed = (await res.json()) as ParsedDemo;
    this.logger.log(
      `[demo-parser] parsed ${DemoParserService.timing(startedAt, respondedAt)}: ${DemoParserService.summarize(parsed)}`,
    );
    return parsed;
  }

  // How long a parse took as the api saw it: until the parser answered (it
  // downloads, parses and starts writing before it does) and then reading the
  // JSON off the wire. The parser's own log has the split inside the first.
  private static timing(startedAt: number, respondedAt: number): string {
    const done = Date.now();
    return `in ${((done - startedAt) / 1000).toFixed(1)}s (answered after ${((respondedAt - startedAt) / 1000).toFixed(1)}s, body read in ${done - respondedAt}ms)`;
  }

  private static summarize(parsed: ParsedDemo): string {
    return `${parsed.total_ticks} ticks @ ${parsed.tick_rate} tps, ${parsed.round_ticks?.length ?? 0} rounds, ${parsed.kills?.length ?? 0} kills, ${parsed.bombs?.length ?? 0} bombs, ${parsed.shots_fired?.length ?? 0} shots, ${parsed.damages?.length ?? 0} dmg, ${parsed.spotted?.length ?? 0} spotted, ${parsed.grenade_throws?.length ?? 0} thrown, ${parsed.grenade_detonations?.length ?? 0} detonated, map=${parsed.map_name ?? "<unknown>"}${parsed.workshop_id ? ` (workshop ${parsed.workshop_id})` : ""}`;
  }

  public async parseFromUrl(
    demoUrl: string,
    playback?: PlaybackRequest,
  ): Promise<ParsedDemo | null> {
    this.logger.log(
      `[demo-parser] POST ${this.appConfig.demoParserUrl}/parse (external url)`,
    );

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await this.postParse(demoUrl, undefined, playback);
    } catch (error) {
      this.logger.error(
        `[demo-parser] external url failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${(error as Error).message}`,
      );
      return null;
    }
    const respondedAt = Date.now();

    const parsed = (await res.json()) as ParsedDemo;
    this.logger.log(
      `[demo-parser] external url parsed ${DemoParserService.timing(startedAt, respondedAt)}: ${DemoParserService.summarize(parsed)}`,
    );
    return parsed;
  }

  private async postParse(
    demoUrl: string,
    matchMapDemoId?: string,
    playback?: PlaybackRequest,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.appConfig.demoParserUrl}/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_map_demo_id: matchMapDemoId ?? "",
          demo_url: demoUrl,
          ...(playback ? { playback } : {}),
        }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      const cause = (error as Error)?.cause as
        | { code?: string; message?: string }
        | undefined;
      const code = cause?.code;
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        throw new Error(
          `demo-parser DNS lookup failed (${this.appConfig.demoParserUrl}) — is the deployment installed? See 5stack-panel/base/demo-parser`,
        );
      }
      if (code === "ECONNREFUSED") {
        throw new Error(
          `demo-parser is up but rejecting connections — pod not yet ready`,
        );
      }
      throw new Error(`demo-parser unreachable: ${message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `demo-parser ${res.status}: ${text.slice(0, 300).trim()}`,
      );
    }

    return res;
  }

  // The measured bloom at a point: the free space a smoke would actually fill
  // there, flooded against the map's collision mesh. Never a hard failure -- a
  // map with no published mesh, a point that resolves inside geometry, and a
  // parser that is not deployed are all normal, and all of them mean the viewer
  // falls back to drawing a sphere.
  public async smokeVolume(
    mapName: string,
    point: { x: number; y: number; z: number },
  ): Promise<ParsedSmokeVolumeResponse | null> {
    const url = `${this.appConfig.demoParserUrl}/smoke-volume`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          map: mapName,
          x: point.x,
          y: point.y,
          z: point.z,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      this.logger.warn(
        `[smoke-volume] ${mapName} unreachable: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.warn(
        `[smoke-volume] ${mapName} ${res.status}: ${text.slice(0, 200).trim()}`,
      );
      return null;
    }

    try {
      const volume = (await res.json()) as ParsedSmokeVolumeResponse;
      // A grid with a zero dimension holds no cells at all; embedding it would
      // make the viewer render an empty box instead of falling back.
      if (!volume?.dx || !volume?.dy || !volume?.dz) {
        return null;
      }
      return volume;
    } catch (error) {
      this.logger.warn(
        `[smoke-volume] ${mapName} sent a body that is not a volume: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  // The smoke the game itself simulated, rebuilt from the voxel log the
  // practice plugin read off the live projectile, in the row the playback blob
  // carries. Never a hard failure either: a 422 is a log with nothing in it to
  // rebuild, and without a row the lineup keeps its estimated bloom.
  public async smokeVoxels(
    capture: UtilitySmokeVoxelCapture,
  ): Promise<ParsedSmokeVoxels | null> {
    const url = `${this.appConfig.demoParserUrl}/smoke-voxels`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          log: capture.log,
          samples: capture.samples,
          detonation: capture.detonation,
          tick_rate: capture.tick_rate,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      this.logger.warn(
        `[smoke-voxels] unreachable: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.warn(
        `[smoke-voxels] ${res.status}: ${text.slice(0, 200).trim()}`,
      );
      return null;
    }

    try {
      const voxels = (await res.json()) as ParsedSmokeVoxels;
      if (!voxels?.dx || !voxels?.dy || !voxels?.dz || !voxels?.arr) {
        return null;
      }
      return voxels;
    } catch (error) {
      this.logger.warn(
        `[smoke-voxels] sent a body that is not a voxel grid: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  // Density-aware occlusion: for each pair, how much smoke sits on the line and
  // whether the map was already in the way. A line the map blocks is attributed
  // to "world", so a lineup can never take credit for a wall.
  public async sightlines(
    request: ParsedSightlineRequest,
  ): Promise<DemoParserResult<ParsedSightlineResponse>> {
    return await this.geometry<ParsedSightlineResponse>(
      "/sightlines",
      request,
      60_000,
    );
  }

  // Asymmetric visibility across stances. Eye-to-eye can never be one-way --
  // the integral is symmetric -- so every asymmetry here comes from stance and
  // from which body samples each side can see.
  public async oneWay(
    request: ParsedOneWayRequest,
  ): Promise<DemoParserResult<ParsedOneWayResponse>> {
    return await this.geometry<ParsedOneWayResponse>(
      "/oneway",
      request,
      60_000,
    );
  }

  // Which lineups a map patch moved. The endpoint holds two meshes for the life
  // of a request and serializes itself, so a caller waits in line: the timeout
  // covers queueing behind another map's scan, not just the flights.
  public async drift(
    request: ParsedDriftRequest,
  ): Promise<DemoParserResult<ParsedDriftResponse>> {
    return await this.geometry<ParsedDriftResponse>(
      "/drift",
      request,
      15 * 60_000,
    );
  }

  private async geometry<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<DemoParserResult<T>> {
    const url = `${this.appConfig.demoParserUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.logger.warn(`[demo-parser] ${path} unreachable: ${message}`);
      return { data: null, status: null, error: "demo-parser unreachable" };
    }

    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300).trim();
      this.logger.warn(`[demo-parser] ${path} ${res.status}: ${text}`);
      return {
        data: null,
        status: res.status,
        error: text || `demo-parser responded ${res.status}`,
      };
    }

    try {
      return { data: (await res.json()) as T, status: res.status, error: null };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.logger.warn(`[demo-parser] ${path} sent an unreadable body`);
      return { data: null, status: res.status, error: message };
    }
  }
}
