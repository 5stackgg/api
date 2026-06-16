import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Service } from "../s3/s3.service";
import { AppConfig } from "../configs/types/AppConfig";

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

export type ParsedDemo = {
  total_ticks: number;
  tick_rate: number;
  map_name?: string;
  workshop_id?: string;
  cs2_build?: string;
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
  ): Promise<ParsedDemo> {
    const presignedUrl = await this.s3.getPresignedUrl(
      s3Key,
      undefined,
      60 * 30,
      "get",
    );

    const url = `${this.appConfig.demoParserUrl}/parse`;
    this.logger.log(
      `[demo-parser] POST ${url} (s3_key=${s3Key}${matchMapDemoId ? ` id=${matchMapDemoId}` : ""})`,
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_map_demo_id: matchMapDemoId ?? "",
          demo_url: presignedUrl,
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

    const parsed = (await res.json()) as ParsedDemo;
    this.logger.log(
      `[demo-parser] parsed: ${parsed.total_ticks} ticks @ ${parsed.tick_rate} tps, ${parsed.round_ticks?.length ?? 0} rounds, ${parsed.kills?.length ?? 0} kills, ${parsed.bombs?.length ?? 0} bombs, ${parsed.shots_fired?.length ?? 0} shots, ${parsed.damages?.length ?? 0} dmg, ${parsed.spotted?.length ?? 0} spotted, ${parsed.grenade_throws?.length ?? 0} thrown, ${parsed.grenade_detonations?.length ?? 0} detonated, map=${parsed.map_name ?? "<unknown>"}${parsed.workshop_id ? ` (workshop ${parsed.workshop_id})` : ""}`,
    );
    return parsed;
  }

  public async parseFromBuffer(
    buffer: Buffer,
    filename = "upload.dem",
  ): Promise<ParsedDemo | null> {
    const url = `${this.appConfig.demoParserUrl}/parse-file`;
    this.logger.log(
      `[demo-parser] POST ${url} (buffer ${buffer.length} bytes)`,
    );

    const form = new FormData();
    form.append(
      "demo",
      new Blob([Uint8Array.from(buffer)], {
        type: "application/octet-stream",
      }),
      filename,
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (error) {
      this.logger.error(`[demo-parser] unreachable for buffer upload`, error);
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(
        `[demo-parser] ${res.status}: ${text.slice(0, 300).trim()}`,
      );
      return null;
    }
    return (await res.json()) as ParsedDemo;
  }

  public async parseFromUrl(demoUrl: string): Promise<ParsedDemo | null> {
    const url = `${this.appConfig.demoParserUrl}/parse`;
    this.logger.log(`[demo-parser] POST ${url} (external url)`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match_map_demo_id: "", demo_url: demoUrl }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch (error) {
      this.logger.error(`[demo-parser] unreachable for external url`, error);
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(
        `[demo-parser] ${res.status}: ${text.slice(0, 300).trim()}`,
      );
      return null;
    }

    return (await res.json()) as ParsedDemo;
  }
}
