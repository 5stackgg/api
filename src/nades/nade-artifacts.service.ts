import zlib from "zlib";
import { Injectable, Logger } from "@nestjs/common";
import { S3Service } from "../s3/s3.service";
import { PostgresService } from "../postgres/postgres.service";
import {
  DemoParserService,
  ParsedSmokeVolumeResponse,
} from "../demos/demo-parser.service";

// v2 carries the projectile's physics seed alongside the sampled path, so a
// simulator can re-emit the throw instead of interpolating it. v3 populates
// smoke_volumes with the real measured bloom, so the viewer stops drawing a
// sphere -- the array existed and was always empty before, so a v2 reader that
// walks it still works.
export const NADE_TRAJECTORY_VERSION = 3;

export type NadeTrajectoryPoint = {
  tick: number;
  x: number;
  y: number;
  z: number;
};

export type NadeVector = { x: number; y: number; z: number };

export type NadeTrajectoryInput = {
  lineupId: string;
  mapName: string;
  nadeType: string;
  throwerSteamId: string | null;
  throwerTeam: string | null;
  origin: NadeVector;
  land: NadeVector;
  // The engine's own starting state. Null for anything not recorded live: a
  // reader must be able to tell "no seed" from "a seed at the origin".
  initialPosition: NadeVector | null;
  initialVelocity: NadeVector | null;
  flightTimeMs: number | null;
  tickRate: number;
  path: Array<NadeTrajectoryPoint>;
  // The measured bloom at the landing point. Supplied when the lineup came out
  // of a demo that already carried it; otherwise uploadTrajectory asks the
  // parser. Null is a normal outcome -- not every map has a collision mesh.
  smokeVolume?: ParsedSmokeVolumeResponse | null;
};

// Deliberately the same top-level shape as the demo playback blob
// (buildPlaybackBlob in demo-metadata.service): the web 3D viewer takes a
// ReplayBlob and renders it, so a lineup that arrives in that shape needs no
// second renderer. Everything a lineup has no notion of is present and empty
// rather than absent, because the viewer indexes these arrays directly.
export type NadeTrajectoryBlob = ReturnType<
  typeof NadeArtifactsService.buildTrajectoryBlob
>;

@Injectable()
export class NadeArtifactsService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly postgres: PostgresService,
    private readonly demoParser: DemoParserService,
  ) {}

  public static trajectoryKey(lineupId: string, cacheBuster: number): string {
    return `nades/${lineupId}/trajectory.v${NADE_TRAJECTORY_VERSION}.${cacheBuster}.json.gz`;
  }

  public static buildTrajectoryBlob(input: NadeTrajectoryInput) {
    const path = input.path;
    const lastTick = path.at(-1)?.tick ?? 0;

    const grenade = (
      phase: "thrown" | "detonated",
      point: { x: number; y: number; z: number },
      tick: number,
    ) => ({
      round: 1,
      tick,
      grenade_id: 1,
      thrower_steam_id: input.throwerSteamId,
      thrower_team: input.throwerTeam,
      type: input.nadeType,
      phase,
      x: point.x,
      y: point.y,
      z: point.z,
    });

    return {
      schema_version: NADE_TRAJECTORY_VERSION,
      nade_lineup_id: input.lineupId,
      match_map_id: null as string | null,
      tick_rate: input.tickRate,
      total_ticks: lastTick,
      map_name: input.mapName,
      round_ticks: [{ round: 1, start: 0, end: lastTick }],
      players: [] as Array<unknown>,
      kills: [] as Array<unknown>,
      bombs: [] as Array<unknown>,
      kit_drops: [] as Array<unknown>,
      positions: [] as Array<unknown>,
      shots_fired: [] as Array<unknown>,
      grenade_throws: [
        grenade("thrown", input.origin, 0),
        grenade("detonated", input.land, lastTick),
      ],
      grenade_trajectories: [
        {
          round: 1,
          grenade_id: 1,
          thrower_steam_id: input.throwerSteamId,
          type: input.nadeType,
          flight_time_ms: input.flightTimeMs,
          initial_position: input.initialPosition,
          initial_velocity: input.initialVelocity,
          points: path,
        },
      ],
      smoke_volumes: NadeArtifactsService.smokeVolumes(input, lastTick),
      infernos: [] as Array<unknown>,
      damages: [] as Array<unknown>,
      round_inventory: [] as Array<unknown>,
    };
  }

  // The volume is rebound to this artifact's single synthetic grenade and round
  // so the viewer pairs it with the throw the same way it pairs a demo's.
  private static smokeVolumes(input: NadeTrajectoryInput, lastTick: number) {
    const volume = input.smokeVolume;

    if (!volume) {
      return [] as Array<Record<string, unknown>>;
    }

    return [
      {
        ...volume,
        gid: 1,
        round: 1,
        start_tick: lastTick,
      },
    ];
  }

  public async uploadTrajectory(
    input: NadeTrajectoryInput,
    previousKey: string | null = null,
  ): Promise<string> {
    const key = NadeArtifactsService.trajectoryKey(input.lineupId, Date.now());
    const resolved: NadeTrajectoryInput = {
      ...input,
      smokeVolume: await this.resolveSmokeVolume(input),
    };
    const gz = zlib.gzipSync(
      Buffer.from(
        JSON.stringify(NadeArtifactsService.buildTrajectoryBlob(resolved)),
      ),
    );

    await this.s3.put(key, gz);

    await this.postgres.query(
      `UPDATE public.nade_lineups
          SET trajectory_file = $1,
              trajectory_size = $2::int
        WHERE id = $3::uuid`,
      [key, gz.byteLength, input.lineupId],
    );

    if (previousKey && previousKey !== key) {
      try {
        await this.s3.remove(previousKey);
      } catch (error) {
        this.logger.warn(
          `[nade-trajectory] failed to remove old blob ${previousKey}: ${(error as Error)?.message}`,
        );
      }
    }

    this.logger.log(
      `[nade-trajectory] uploaded ${key} (${gz.byteLength} bytes gzipped, ` +
        `${input.path.length} points, ` +
        `${resolved.smokeVolume ? "with" : "no"} smoke volume)`,
    );

    return key;
  }

  // A smoke's shape is a property of the map, not of the throw, so every smoke
  // lineup gets the real bloom -- plugin-recorded and hand-placed ones included,
  // not just the ones mined out of a demo that measured it already.
  private async resolveSmokeVolume(
    input: NadeTrajectoryInput,
  ): Promise<ParsedSmokeVolumeResponse | null> {
    if (input.smokeVolume) {
      return input.smokeVolume;
    }

    if (input.nadeType !== "Smoke") {
      return null;
    }

    try {
      return await this.demoParser.smokeVolume(input.mapName, input.land);
    } catch (error) {
      this.logger.warn(
        `[nade-trajectory] smoke volume lookup failed for ${input.lineupId}: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  public async readTrajectory(key: string) {
    return await this.s3.get(key);
  }

  // The bloom a v3 artifact already carries. Reading it back is what keeps the
  // blocking search from asking the parser to re-flood a cloud it measured when
  // the lineup was saved; a v2 blob has an empty array and answers null.
  public async readSmokeVolume(
    key: string,
  ): Promise<ParsedSmokeVolumeResponse | null> {
    try {
      const stream = await this.s3.get(key);
      const chunks: Array<Buffer> = [];

      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }

      const blob = JSON.parse(
        zlib.gunzipSync(Buffer.concat(chunks)).toString(),
      ) as NadeTrajectoryBlob;

      const volume = blob?.smoke_volumes?.at(0) as
        | ParsedSmokeVolumeResponse
        | undefined;

      if (!volume?.dx || !volume?.dy || !volume?.dz) {
        return null;
      }

      return volume;
    } catch (error) {
      this.logger.warn(
        `[nade-trajectory] unable to read the smoke volume out of ${key}: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  public async hasTrajectory(key: string): Promise<boolean> {
    return await this.s3.has(key);
  }

  // Deleting the row leaves the blob behind, and a versioned bucket keeps every
  // cache-busted generation of it — sweep the whole prefix, not just the key
  // the row happened to be pointing at.
  public async removeTrajectories(lineupId: string): Promise<void> {
    try {
      await this.s3.removePrefix(`nades/${lineupId}/`);
    } catch (error) {
      this.logger.warn(
        `[nade-trajectory] failed to sweep nades/${lineupId}/: ${(error as Error)?.message}`,
      );
    }
  }
}
