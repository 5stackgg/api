import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import {
  DemoMetadataService,
  PlaybackBlob,
} from "../demos/demo-metadata.service";
import {
  DemoParserService,
  ParsedSmokeVolume,
} from "../demos/demo-parser.service";
import {
  UtilityArtifactsService,
  UtilityTrajectoryPoint,
  UtilityVector,
} from "./utility-artifacts.service";
import { UtilityLineupsService } from "./utility-lineups.service";

export type UtilityMiningRequest = {
  user: User;
  match_id: string;
  match_map_id: string;
  grenade_id: number;
  name: string;
  description?: string | null;
  visibility?: string;
  team_id?: string | null;
  tags?: Array<string>;
  collection_id?: string | null;
};

export type UtilityUtilityTypeReport = {
  utility_type: string;
  throws: number;
  matched_lineups: number;
  matched_meta: number;
  landed: number;
};

export type UtilityUtilityReport = {
  // False means "nobody has looked at this demo yet", which is a different
  // answer from a match where the player threw nothing. Reporting zeroes for
  // an unmined demo tells a player they threw no utility.
  analysed: boolean;
  message: string | null;
  steam_id: string;
  throws: number;
  matched_lineups: number;
  matched_meta: number;
  landed: number;
  radius: number;
  by_type: Array<UtilityUtilityTypeReport>;
};

// Everything the mining pass recovered, before any of it is written. Split out
// so the geometry can be tested without a database, a demo or an S3 bucket.
export type MinedLineup = {
  mapName: string;
  grenadeId: number;
  round: number;
  utilityType: string;
  side: string;
  technique: string;
  throwStrength: string | null;
  origin: UtilityVector;
  eyeZ: number | null;
  viewYaw: number;
  viewPitch: number;
  // How far the trajectory-derived aim sits from the aim the demo recorded for
  // the thrower, in degrees. Null when no position sample was close enough to
  // compare against. Stored rather than resolved: the two disagreeing is the
  // signal that this lineup needs verifying, and picking a winner hides it.
  viewYawDelta: number | null;
  viewPitchDelta: number | null;
  land: UtilityVector;
  flightTimeMs: number | null;
  throwerSteamId: string | null;
  throwTick: number;
  tickRate: number;
  path: Array<UtilityTrajectoryPoint>;
  smokeVolume: ParsedSmokeVolume | null;
  // The magnitude of the release impulse, in units/sec, or null when it could
  // not be measured. The number the strength bucket was decided from, exposed
  // so a throw that fell in a gap can be looked at rather than just refused.
  throwSpeed: number | null;
};

type BlobPosition = PlaybackBlob["positions"][number];
type BlobGrenade = PlaybackBlob["grenade_throws"][number];
type TrajectoryPoints = Array<{ t: number; x: number; y: number; z: number }>;

// The thrower at the release tick. velocityTicks is how far apart the two
// samples the velocity came from sat, which is what says whether it is an
// instant or a quarter-second average.
type Stance = {
  position: UtilityVector;
  velocity: UtilityVector | null;
  velocityTicks: number | null;
  ducked: boolean;
  rise: number;
  sample: BlobPosition;
};

// One demo's events, keyed the way the derivation walks them.
type BlobIndex = {
  mapName: string;
  tickRate: number;
  thrown: Map<number, BlobGrenade>;
  detonated: Map<number, BlobGrenade>;
  trajectories: Map<number, TrajectoryPoints>;
  volumes: Map<number, ParsedSmokeVolume>;
  positions: Map<string, Array<BlobPosition>>;
};

@Injectable()
export class UtilityMiningService {
  private static readonly SIDES: Record<string, string> = {
    ct: "CT",
    CT: "CT",
    t: "TERRORIST",
    T: "TERRORIST",
    TERRORIST: "TERRORIST",
  };

  // A full-power throw leaves the hand at ~750 u/s; the engine scales the same
  // forward vector down for the weaker two. The bands are wide and do not
  // touch: a speed that lands in a gap means the release was something we
  // cannot name, and naming it anyway makes an unreproducible lineup look
  // reproducible.
  private static readonly FULL_THROW_MIN_SPEED = 660;
  private static readonly HALF_THROW_MIN_SPEED = 320;
  private static readonly HALF_THROW_MAX_SPEED = 600;
  private static readonly DROP_THROW_MAX_SPEED = 240;

  // Rifle walk tops out around 130 u/s and a rifle run around 215.
  private static readonly STATIONARY_MAX_SPEED = 20;
  private static readonly WALK_MAX_SPEED = 145;

  // A jump lifts a player ~57 units. Either the rise itself or the vertical
  // speed at release is enough to call it, which matters because a hand-timed
  // jump throw releases near the apex where the vertical speed is briefly zero.
  private static readonly JUMP_MIN_RISE = 12;
  private static readonly JUMP_MIN_VERTICAL_SPEED = 60;

  private static readonly STANDING_EYE_HEIGHT = 64;
  private static readonly DUCKED_EYE_HEIGHT = 46;

  // Beyond this the nearest position sample is describing a different moment.
  // The parser bursts positions to full rate for ten ticks either side of a
  // throw, so on a current demo the nearest sample is a tick or two away; an
  // older blob falls back to the 4Hz timeline and lands outside this window.
  private static readonly MAX_SAMPLE_LAG_TICKS = 12;

  // How far back to look for the standstill a throw was set up from. A run-up
  // into a jump throw is over in well under a second; two seconds is generous
  // and still inside the same engagement.
  private static readonly SETUP_LOOKBACK_SECONDS = 2;

  // Horizontal units/sec that still counts as standing still, matching the
  // in-game recorder so a demo-mined lineup and a recorded one agree.
  private static readonly SETUP_STATIONARY_SPEED = 12;

  // How far above the lowest point in the lookback a sample may sit and still
  // count as grounded. Without this the apex of a straight-up jump qualifies:
  // horizontal speed there is zero too.
  private static readonly SETUP_GROUND_TOLERANCE = 6;

  // How far apart the two samples either side of the release may sit before the
  // velocity they imply is an average rather than an instant. The burst puts
  // them one tick apart; without it they are sixteen.
  private static readonly MAX_VELOCITY_PAIR_TICKS = 4;

  // The fit only needs the opening of the flight, before drag and the first
  // bounce. Trajectory points are sampled every other tick, so four of them
  // span about 90ms.
  private static readonly FIT_POINTS = 4;

  // Source's own gravity. A projectile's is scaled down from it, so the fitted
  // value is checked against a wide band rather than this number: what the
  // check is really testing is that the tick rate converts the fit to seconds
  // correctly, and a nonsense gravity is how a wrong tick rate shows up.
  private static readonly SOURCE_GRAVITY = 800;
  private static readonly MIN_PLAUSIBLE_GRAVITY = 100;
  private static readonly MAX_PLAUSIBLE_GRAVITY =
    2 * UtilityMiningService.SOURCE_GRAVITY;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly hasura: HasuraService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly artifacts: UtilityArtifactsService,
    private readonly lineups: UtilityLineupsService,
  ) {}

  public async saveFromDemo(
    request: UtilityMiningRequest,
  ): Promise<{ id: string }> {
    if (!(await this.lineups.isLibraryEnabled())) {
      throw Error("the utility library is disabled");
    }

    const grenadeId = Number(request.grenade_id);

    if (!Number.isInteger(grenadeId) || grenadeId <= 0) {
      throw Error("grenade_id is not a grenade");
    }

    const mapName = await this.authorizeMatchMap(request);
    const blob = await this.playbackBlob(request.match_map_id);
    const mined = UtilityMiningService.mine(blob, grenadeId, mapName);

    await this.lineups.assertDailyLineupLimit(request.user.steam_id);

    // The same gate saveFromPractice runs: this INSERT is on the API's own
    // connection, where tbiu_utility_lineups_public sees no role and approves
    // whatever visibility it is handed.
    const visibility = UtilityLineupsService.visibilityFor(
      request.visibility,
      request.user,
    );

    const [inserted] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.utility_lineups
         (map_name, utility_type, side, technique, throw_strength, jump_throw_bind,
          origin_x, origin_y, origin_z, eye_z, view_yaw, view_pitch,
          view_yaw_delta, view_pitch_delta,
          land_x, land_y, land_z, flight_time_ms,
          name, description, tags, visibility, team_id, author_steam_id,
          origin_source, source_match_id, source_match_map_id, source_grenade_id,
          confidence, verified_at, trajectory_preview,
          public_requested_at, public_reviewed_by)
       VALUES ($1, $2, $3, $4, $5, false,
               $6, $7, $8, $9, $10, $11,
               $12, $13,
               $14, $15, $16, $17,
               $18, $19, $20::text[], $21, $22::uuid, $23::bigint,
               'demo', $24::uuid, $25::uuid, $26::int,
               'derived', NULL, $27::jsonb,
               CASE WHEN $28::boolean THEN now() END, $29::bigint)
       RETURNING id::text AS id`,
      [
        mined.mapName,
        mined.utilityType,
        mined.side,
        mined.technique,
        mined.throwStrength,
        mined.origin.x,
        mined.origin.y,
        mined.origin.z,
        mined.eyeZ,
        mined.viewYaw,
        mined.viewPitch,
        mined.viewYawDelta,
        mined.viewPitchDelta,
        mined.land.x,
        mined.land.y,
        mined.land.z,
        mined.flightTimeMs,
        UtilityLineupsService.sanitizeName(request.name, mined.mapName),
        UtilityLineupsService.sanitizeText(request.description, 1000),
        (request.tags ?? [])
          .slice(0, 16)
          .map((tag) => String(tag).slice(0, 40)),
        visibility.visibility,
        request.team_id ?? null,
        request.user.steam_id,
        request.match_id,
        request.match_map_id,
        mined.grenadeId,
        JSON.stringify(UtilityLineupsService.preview(mined.path)),
        visibility.requestedPublic,
        visibility.reviewedBy,
      ],
    );

    if (mined.path.length > 0) {
      await this.artifacts.uploadTrajectory({
        lineupId: inserted.id,
        mapName: mined.mapName,
        utilityType: mined.utilityType,
        throwerSteamId: mined.throwerSteamId,
        throwerTeam: mined.side,
        origin: mined.origin,
        land: mined.land,
        // A demo carries no m_vInitialPosition / m_vInitialVelocity. Filling
        // them from the fit would be a guess wearing the badge of an engine
        // measurement, and a lineup with a seed claims to be replayable exactly.
        initialPosition: null,
        initialVelocity: null,
        flightTimeMs: mined.flightTimeMs,
        tickRate: mined.tickRate,
        path: mined.path,
        smokeVolume: mined.smokeVolume,
      });
    }

    if (request.collection_id) {
      await this.postgres.query(
        `INSERT INTO public.utility_collection_items (collection_id, utility_lineup_id)
         SELECT $1::uuid, $2::uuid
          WHERE EXISTS (
            SELECT 1 FROM public.utility_collections c
             WHERE c.id = $1::uuid AND c.owner_steam_id = $3::bigint
          )
         ON CONFLICT DO NOTHING`,
        [request.collection_id, inserted.id, request.user.steam_id],
      );
    }

    this.logger.log(
      `[utility-mining] ${request.user.steam_id} mined ${mined.utilityType} ${inserted.id} ` +
        `from grenade ${grenadeId} on ${mined.mapName} ` +
        `(${mined.technique}, ${mined.throwStrength ?? "unknown strength"})`,
    );

    return { id: inserted.id };
  }

  // "You threw 12 utility; 4 matched known lineups; 3 landed correctly."
  //
  // Computed on read, never stored. Every input is already a persisted, indexed
  // fact -- utility_demo_throws is the fact table, and both lineup_bucket columns
  // are indexed -- and the answer is not a property of the match: it moves when
  // the library does (save the lineup tomorrow and yesterday's throw matched
  // it) and it is cut by the caller's own visibility, so two people asking
  // about the same match are not asking the same question. A stored row would
  // be one viewer's answer against a library that has since moved on.
  public async utilityReport(
    user: User,
    input: { match_id: string; steam_id?: string | null },
  ): Promise<UtilityUtilityReport> {
    await this.authorizeMatch(input.match_id, user.steam_id);

    const steamId = String(input.steam_id ?? user.steam_id);

    if (!/^\d{5,20}$/.test(steamId)) {
      throw Error("steam_id is not a steam id");
    }

    const [coverage] = await this.postgres.query<
      Array<{ demos: string; mined: string }>
    >(
      `SELECT count(*) FILTER (WHERE d.playback_file IS NOT NULL) AS demos,
              count(*) FILTER (WHERE mined.match_map_demo_id IS NOT NULL) AS mined
         FROM public.match_map_demos d
         LEFT JOIN public.utility_demo_mines mined
                ON mined.match_map_demo_id = d.id
               AND mined.failed_reason IS NULL
        WHERE d.match_id = $1::uuid`,
      [input.match_id],
    );

    const radius = await this.lineups.successRadius();
    const demos = Number(coverage?.demos ?? 0);
    const mined = Number(coverage?.mined ?? 0);

    if (mined === 0) {
      return {
        analysed: false,
        message:
          demos === 0
            ? "this match has no demo to analyse"
            : "this match's demo has not been mined yet",
        steam_id: steamId,
        throws: 0,
        matched_lineups: 0,
        matched_meta: 0,
        landed: 0,
        radius,
        by_type: [],
      };
    }

    const byType = await this.postgres.query<
      Array<{
        utility_type: string;
        throws: string;
        matched_lineups: string;
        matched_meta: string;
        landed: string;
      }>
    >(
      `SELECT t.utility_type,
              count(*) AS throws,
              count(*) FILTER (WHERE nearest.id IS NOT NULL) AS matched_lineups,
              count(*) FILTER (WHERE meta.lineup_bucket IS NOT NULL) AS matched_meta,
              count(*) FILTER (WHERE nearest.distance <= $3::float8) AS landed
         FROM public.utility_demo_throws t
         LEFT JOIN LATERAL (
           SELECT l.id,
                  sqrt(
                    (l.land_x - t.land_x) ^ 2 +
                    (l.land_y - t.land_y) ^ 2 +
                    (l.land_z - t.land_z) ^ 2
                  ) AS distance
             FROM public.utility_lineups l
            WHERE l.lineup_bucket = t.lineup_bucket
              AND l.archived_at IS NULL
              AND public.can_view_utility_lineup(l, $4::json)
            ORDER BY distance ASC
            LIMIT 1
         ) AS nearest ON true
         LEFT JOIN public.utility_meta_lineups meta
                ON meta.lineup_bucket = t.lineup_bucket
        WHERE t.match_id = $1::uuid
          AND t.thrower_steam_id = $2::bigint
        GROUP BY t.utility_type
        ORDER BY t.utility_type ASC`,
      [
        input.match_id,
        steamId,
        radius,
        JSON.stringify({
          "x-hasura-role": user.role,
          "x-hasura-user-id": user.steam_id,
        }),
      ],
    );

    const rows: Array<UtilityUtilityTypeReport> = byType.map((row) => ({
      utility_type: row.utility_type,
      throws: Number(row.throws),
      matched_lineups: Number(row.matched_lineups),
      matched_meta: Number(row.matched_meta),
      landed: Number(row.landed),
    }));

    const total = (pick: (row: UtilityUtilityTypeReport) => number) =>
      rows.reduce((sum, row) => sum + pick(row), 0);

    return {
      analysed: true,
      // A Bo3 whose third map has not been mined would otherwise read as a
      // complete account of the series.
      message:
        mined < demos
          ? `${mined} of ${demos} demo(s) for this match have been mined`
          : null,
      steam_id: steamId,
      throws: total((row) => row.throws),
      matched_lineups: total((row) => row.matched_lineups),
      matched_meta: total((row) => row.matched_meta),
      landed: total((row) => row.landed),
      radius,
      by_type: rows,
    };
  }

  // Same gate as authorizeMatchMap, at match granularity: a report is about a
  // whole series, and the caller has to be able to see the match to get one.
  private async authorizeMatch(
    matchId: string,
    steamId: string,
  ): Promise<void> {
    const { matches } = await this.hasura.query(
      {
        matches: {
          __args: {
            where: { id: { _eq: matchId } },
            limit: 1,
          },
          id: true,
        },
      },
      steamId,
    );

    if (!matches?.at(0)) {
      throw Error("match not found");
    }
  }

  // Whether this user may look at this demo at all is Hasura's call, not ours:
  // the match is re-queried under the caller's own steam id so the same row
  // permissions that hide a match from them hide its grenades too. The admin
  // client is used only afterwards, to read the blob out of S3.
  private async authorizeMatchMap(request: UtilityMiningRequest): Promise<string> {
    const { matches } = await this.hasura.query(
      {
        matches: {
          __args: {
            where: { id: { _eq: request.match_id } },
            limit: 1,
          },
          id: true,
          match_maps: {
            __args: {
              where: { id: { _eq: request.match_map_id } },
              limit: 1,
            },
            id: true,
            map: {
              name: true,
            },
          },
        },
      },
      request.user.steam_id,
    );

    const match = matches?.at(0);

    if (!match) {
      throw Error("match not found");
    }

    const matchMap = match.match_maps?.at(0);

    if (!matchMap) {
      throw Error("that map is not part of this match");
    }

    const mapName = matchMap.map?.name;

    if (!mapName) {
      throw Error("that map has no name to file a lineup under");
    }

    return mapName;
  }

  private async playbackBlob(matchMapId: string): Promise<PlaybackBlob> {
    const [demo] = await this.postgres.query<
      Array<{ playback_file: string | null }>
    >(
      `SELECT playback_file
         FROM public.match_map_demos
        WHERE match_map_id = $1::uuid
          AND playback_file IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [matchMapId],
    );

    if (!demo?.playback_file) {
      throw Error("that map has no parsed demo to mine");
    }

    return await this.demoMetadata.readPlaybackBlob(demo.playback_file);
  }

  public static mine(
    blob: PlaybackBlob,
    grenadeId: number,
    mapName: string,
  ): MinedLineup {
    return UtilityMiningService.mineThrow(
      UtilityMiningService.index(blob, mapName),
      grenadeId,
    );
  }

  // Every throw in one demo that the same derivation can recover, for the meta
  // pass. A grenade that was never sampled, never landed, or came off a player
  // the demo lost track of is skipped rather than reported: most demos have a
  // handful of those and none of them is a fault.
  public static mineAll(
    blob: PlaybackBlob,
    mapName: string,
  ): Array<MinedLineup> {
    const context = UtilityMiningService.index(blob, mapName);
    const mined: Array<MinedLineup> = [];

    for (const grenadeId of context.thrown.keys()) {
      try {
        mined.push(UtilityMiningService.mineThrow(context, grenadeId));
      } catch {
        continue;
      }
    }

    return mined;
  }

  // One pass over the blob's arrays, so mining three hundred grenades out of
  // one demo is three hundred lookups rather than three hundred scans of fifty
  // thousand position rows.
  private static index(blob: PlaybackBlob, mapName: string): BlobIndex {
    const thrown = new Map<number, BlobGrenade>();
    const detonated = new Map<number, BlobGrenade>();

    for (const grenade of blob.grenade_throws ?? []) {
      const grenadeId = grenade.grenade_id;

      if (grenadeId === null || grenadeId === undefined) {
        continue;
      }

      const into = grenade.phase === "thrown" ? thrown : detonated;

      if (!into.has(grenadeId)) {
        into.set(grenadeId, grenade);
      }
    }

    const trajectories = new Map<number, TrajectoryPoints>();

    for (const trajectory of blob.grenade_trajectories ?? []) {
      trajectories.set(trajectory.gid, trajectory.pts ?? []);
    }

    const volumes = new Map<number, ParsedSmokeVolume>();

    for (const volume of blob.smoke_volumes ?? []) {
      if (volume.gid !== null && volume.gid !== undefined) {
        volumes.set(volume.gid, volume);
      }
    }

    const positions = new Map<string, Array<BlobPosition>>();

    for (const position of blob.positions ?? []) {
      const steamId = position.attacker_steam_id;

      if (!steamId) {
        continue;
      }

      const samples = positions.get(steamId);

      if (samples) {
        samples.push(position);
        continue;
      }

      positions.set(steamId, [position]);
    }

    for (const samples of positions.values()) {
      samples.sort((a, b) => a.tick - b.tick);
    }

    return {
      mapName,
      tickRate: Number(blob.tick_rate) > 0 ? Number(blob.tick_rate) : 64,
      thrown,
      detonated,
      trajectories,
      volumes,
      positions,
    };
  }

  private static mineThrow(context: BlobIndex, grenadeId: number): MinedLineup {
    const { mapName, tickRate } = context;
    const thrown = context.thrown.get(grenadeId);

    if (!thrown) {
      throw Error("that grenade was not thrown in this demo");
    }

    const detonated = context.detonated.get(grenadeId);

    if (!detonated) {
      throw Error("that grenade never landed, so there is nothing to aim at");
    }

    const utilityType = DemoParserService.utilityType(thrown.type);

    if (!utilityType) {
      throw Error(`unknown grenade type ${thrown.type}`);
    }

    const side = UtilityMiningService.SIDES[String(thrown.thrower_team ?? "")];

    if (!side) {
      throw Error("that grenade has no thrower side");
    }

    const points = context.trajectories.get(grenadeId) ?? [];

    if (points.length < 3) {
      throw Error(
        "the demo did not sample enough of that grenade's flight to recover the throw",
      );
    }

    const release = UtilityMiningService.releaseVelocity(points, tickRate);
    const samples = context.positions.get(thrown.thrower_steam_id ?? "") ?? [];
    const stance = UtilityMiningService.stanceAt(samples, thrown.tick, tickRate);

    const carried = UtilityMiningService.carriedVelocity(stance);

    // The engine adds the player's own velocity to the throw, so the release
    // velocity is the impulse plus the run. Only the impulse points where the
    // crosshair pointed, and only its magnitude is the release strength -- on a
    // run throw the two differ by the better part of twenty degrees.
    const impulse = carried
      ? {
          x: release.velocity.x - carried.x,
          y: release.velocity.y - carried.y,
          z: release.velocity.z - carried.z,
        }
      : release.velocity;

    const aim = UtilityMiningService.anglesOf(impulse);
    const recorded = stance?.sample;

    // The origin is where you STAND, so it comes from the standstill the throw
    // was set up from rather than the release tick. The aim above is untouched
    // by this: it is derived from the impulse velocity, not from the origin.
    const setup = UtilityMiningService.setupPosition(
      samples,
      thrown.tick,
      tickRate,
    );

    const origin = setup
      ? { x: setup.x, y: setup.y, z: setup.z }
      : (stance?.position ?? {
          x: thrown.x,
          y: thrown.y,
          // Without a position sample the only height we have is the
          // projectile's spawn, which sits at eye level rather than at the
          // player's feet.
          z: thrown.z - UtilityMiningService.STANDING_EYE_HEIGHT,
        });

    const flightTicks = detonated.tick - thrown.tick;

    return {
      mapName,
      grenadeId,
      round: thrown.round ?? 0,
      utilityType,
      side,
      technique: UtilityMiningService.techniqueOf(stance),
      throwStrength:
        release.trustedScale && carried
          ? UtilityMiningService.strengthOf(UtilityMiningService.magnitude(impulse))
          : null,
      throwSpeed:
        release.trustedScale && carried
          ? UtilityMiningService.magnitude(impulse)
          : null,
      origin,
      // Measured from the setup stance too, and from whether they were crouched
      // THERE -- a jump throw releases standing even if it was set up ducked.
      eyeZ:
        origin.z +
        ((setup ? setup.ducked === true : stance?.ducked)
          ? UtilityMiningService.DUCKED_EYE_HEIGHT
          : UtilityMiningService.STANDING_EYE_HEIGHT),
      viewYaw: aim.yaw,
      viewPitch: aim.pitch,
      viewYawDelta:
        recorded?.yaw === null || recorded?.yaw === undefined
          ? null
          : UtilityMiningService.angleDelta(aim.yaw, Number(recorded.yaw)),
      viewPitchDelta:
        recorded?.pitch === null || recorded?.pitch === undefined
          ? null
          : UtilityMiningService.angleDelta(aim.pitch, Number(recorded.pitch)),
      land: { x: detonated.x, y: detonated.y, z: detonated.z },
      flightTimeMs:
        flightTicks > 0 ? Math.round((flightTicks / tickRate) * 1000) : null,
      throwerSteamId: thrown.thrower_steam_id ?? null,
      throwTick: thrown.tick,
      tickRate,
      path: UtilityMiningService.pathOf(points, thrown.tick),
      smokeVolume: context.volumes.get(grenadeId) ?? null,
    };
  }

  // Recovers the velocity the grenade left the hand with by fitting a parabola
  // through the opening of its flight. The linear coefficient of that fit IS
  // the gravity-free velocity, which is why the gravity constant appears here
  // only as a sanity check: the quadratic coefficient has to come back as a
  // plausible gravity, otherwise the tick rate is not what converts the fit to
  // seconds and every speed derived from it would be wrong.
  private static releaseVelocity(
    points: TrajectoryPoints,
    tickRate: number,
  ): { velocity: UtilityVector; gravity: number; trustedScale: boolean } {
    const sample = points.slice(0, UtilityMiningService.FIT_POINTS);
    const base = sample[0].t;
    const ticks = sample.map((point) => point.t - base);

    const fitX = UtilityMiningService.fitQuadratic(
      ticks,
      sample.map((point) => point.x),
    );
    const fitY = UtilityMiningService.fitQuadratic(
      ticks,
      sample.map((point) => point.y),
    );
    const fitZ = UtilityMiningService.fitQuadratic(
      ticks,
      sample.map((point) => point.z),
    );

    if (!fitX || !fitY || !fitZ) {
      throw Error("that grenade's flight is not a trajectory");
    }

    const gravity = -2 * fitZ[2] * tickRate * tickRate;

    return {
      velocity: {
        x: fitX[1] * tickRate,
        y: fitY[1] * tickRate,
        z: fitZ[1] * tickRate,
      },
      gravity,
      trustedScale:
        gravity >= UtilityMiningService.MIN_PLAUSIBLE_GRAVITY &&
        gravity <= UtilityMiningService.MAX_PLAUSIBLE_GRAVITY,
    };
  }

  // Least squares c0 + c1*u + c2*u^2 over the normal equations. With exactly
  // three distinct samples this is the interpolating parabola.
  private static fitQuadratic(
    us: Array<number>,
    vs: Array<number>,
  ): [number, number, number] | null {
    if (us.length < 3 || new Set(us).size < 3) {
      return null;
    }

    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;

    for (let index = 0; index < us.length; index++) {
      const u = us[index];
      const v = vs[index];
      const u2 = u * u;

      s0 += 1;
      s1 += u;
      s2 += u2;
      s3 += u2 * u;
      s4 += u2 * u2;
      b0 += v;
      b1 += u * v;
      b2 += u2 * v;
    }

    return UtilityMiningService.solve3(
      [
        [s0, s1, s2],
        [s1, s2, s3],
        [s2, s3, s4],
      ],
      [b0, b1, b2],
    );
  }

  private static solve3(
    matrix: Array<Array<number>>,
    rhs: Array<number>,
  ): [number, number, number] | null {
    const a = matrix.map((row, index) => [...row, rhs[index]]);

    for (let column = 0; column < 3; column++) {
      let pivot = column;
      for (let row = column + 1; row < 3; row++) {
        if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) {
          pivot = row;
        }
      }

      if (Math.abs(a[pivot][column]) < 1e-12) {
        return null;
      }

      [a[column], a[pivot]] = [a[pivot], a[column]];

      for (let row = 0; row < 3; row++) {
        if (row === column) {
          continue;
        }
        const factor = a[row][column] / a[column][column];
        for (let col = column; col < 4; col++) {
          a[row][col] -= factor * a[column][col];
        }
      }
    }

    const solved: [number, number, number] = [
      a[0][3] / a[0][0],
      a[1][3] / a[1][1],
      a[2][3] / a[2][2],
    ];

    return solved.every((value) => Number.isFinite(value)) ? solved : null;
  }

  public static anglesOf(velocity: UtilityVector): {
    yaw: number;
    pitch: number;
  } {
    const speed = UtilityMiningService.magnitude(velocity);

    if (speed === 0) {
      throw Error("that grenade left the hand with no velocity");
    }

    return {
      yaw: UtilityMiningService.round(
        (Math.atan2(velocity.y, velocity.x) * 180) / Math.PI,
      ),
      // Source counts pitch positive downwards, so a grenade going up came off
      // a negative pitch.
      pitch: UtilityMiningService.round(
        (-Math.asin(velocity.z / speed) * 180) / Math.PI,
      ),
    };
  }

  // Where the thrower was, how fast, and in what stance at the release tick.
  // Straddling samples give the velocity by finite difference, which is only
  // meaningful because the parser bursts positions to full rate around a throw
  // -- at the 4Hz baseline the nearest sample can be 125ms and thirty units of
  // running out of date.
  // Where the thrower was STANDING when they set the throw up, which is not
  // where they were when it left their hand. A jump throw releases at the apex
  // and a run throw releases a run-up away, so the release tick answers "where
  // was the grenade born", never "where do I stand to do this".
  private static setupPosition(
    samples: Array<BlobPosition>,
    tick: number,
    tickRate: number,
  ): BlobPosition | null {
    const lookback =
      UtilityMiningService.SETUP_LOOKBACK_SECONDS * Math.max(tickRate, 1);

    const window = samples
      .filter((sample) => sample.tick <= tick && sample.tick >= tick - lookback)
      .sort((a, b) => a.tick - b.tick);

    if (window.length < 2) {
      return null;
    }

    const floor = Math.min(...window.map((sample) => sample.z));

    // Backwards from the release: the LAST standstill before the throw is the
    // one the player was lining up from.
    for (let index = window.length - 1; index > 0; index--) {
      const sample = window[index];
      const previous = window[index - 1];
      const seconds = (sample.tick - previous.tick) / Math.max(tickRate, 1);

      if (seconds <= 0) {
        continue;
      }

      const speed =
        Math.hypot(sample.x - previous.x, sample.y - previous.y) / seconds;

      if (speed > UtilityMiningService.SETUP_STATIONARY_SPEED) {
        continue;
      }

      if (sample.z > floor + UtilityMiningService.SETUP_GROUND_TOLERANCE) {
        continue;
      }

      return sample;
    }

    return null;
  }

  private static stanceAt(
    samples: Array<BlobPosition>,
    tick: number,
    tickRate: number,
  ): Stance | null {
    if (samples.length === 0) {
      return null;
    }

    const sorted = [...samples].sort((a, b) => a.tick - b.tick);
    let nearest = sorted[0];

    for (const sample of sorted) {
      if (Math.abs(sample.tick - tick) < Math.abs(nearest.tick - tick)) {
        nearest = sample;
      }
    }

    if (
      Math.abs(nearest.tick - tick) > UtilityMiningService.MAX_SAMPLE_LAG_TICKS
    ) {
      return null;
    }

    const index = sorted.indexOf(nearest);
    const before = sorted[index - 1];
    const after = sorted[index + 1];
    const pair =
      before && after
        ? [before, after]
        : before
          ? [before, nearest]
          : after
            ? [nearest, after]
            : null;

    let velocity: UtilityVector | null = null;
    let velocityTicks: number | null = null;

    if (pair && pair[1].tick > pair[0].tick) {
      velocityTicks = pair[1].tick - pair[0].tick;
      const seconds = velocityTicks / tickRate;
      velocity = {
        x: (pair[1].x - pair[0].x) / seconds,
        y: (pair[1].y - pair[0].y) / seconds,
        z: (pair[1].z - pair[0].z) / seconds,
      };
    }

    const window = sorted.filter(
      (sample) =>
        Math.abs(sample.tick - tick) <= UtilityMiningService.MAX_SAMPLE_LAG_TICKS,
    );
    const heights = window.map((sample) => sample.z);

    return {
      position: { x: nearest.x, y: nearest.y, z: nearest.z },
      velocity,
      velocityTicks,
      ducked: nearest.ducked === true,
      rise:
        heights.length > 1 ? Math.max(...heights) - Math.min(...heights) : 0,
      sample: nearest,
    };
  }

  // The velocity to subtract from the release, or null when the samples are too
  // far apart to be reading the instant of the throw. A pre-burst blob samples
  // at 4Hz, and a quarter-second average of a player who was strafing and
  // stopped is not the velocity the grenade inherited -- subtracting it would
  // move the derived crosshair rather than correct it. A player the samples
  // agree was standing still is the exception: standing still over a wide
  // window means standing still at the release too.
  private static carriedVelocity(stance: Stance | null): UtilityVector | null {
    if (!stance?.velocity || stance.velocityTicks === null) {
      return null;
    }

    if (stance.velocityTicks <= UtilityMiningService.MAX_VELOCITY_PAIR_TICKS) {
      return stance.velocity;
    }

    return UtilityMiningService.magnitude(stance.velocity) <
      UtilityMiningService.STATIONARY_MAX_SPEED
      ? stance.velocity
      : null;
  }

  private static techniqueOf(
    stance: {
      velocity: UtilityVector | null;
      ducked: boolean;
      rise: number;
    } | null,
  ): string {
    if (!stance) {
      // No sample close enough to the release to say anything. Stationary is
      // the honest default: it is what a lineup is practised from, and the
      // confidence on a mined lineup already says none of this is measured.
      return "Stationary";
    }

    const horizontal = stance.velocity
      ? Math.sqrt(stance.velocity.x ** 2 + stance.velocity.y ** 2)
      : 0;
    const vertical = stance.velocity ? Math.abs(stance.velocity.z) : 0;
    const airborne =
      stance.rise >= UtilityMiningService.JUMP_MIN_RISE ||
      vertical >= UtilityMiningService.JUMP_MIN_VERTICAL_SPEED;

    if (airborne) {
      if (stance.ducked) {
        return "CrouchJump";
      }
      if (horizontal > UtilityMiningService.WALK_MAX_SPEED) {
        return "RunJump";
      }
      if (horizontal > UtilityMiningService.STATIONARY_MAX_SPEED) {
        return "WalkJump";
      }
      return "Jump";
    }

    if (stance.ducked) {
      return "Crouch";
    }

    if (horizontal > UtilityMiningService.WALK_MAX_SPEED) {
      return "Running";
    }

    if (horizontal > UtilityMiningService.STATIONARY_MAX_SPEED) {
      return "Walking";
    }

    return "Stationary";
  }

  public static strengthOf(speed: number): string | null {
    if (speed >= UtilityMiningService.FULL_THROW_MIN_SPEED) {
      return "Full";
    }

    if (
      speed >= UtilityMiningService.HALF_THROW_MIN_SPEED &&
      speed <= UtilityMiningService.HALF_THROW_MAX_SPEED
    ) {
      return "Half";
    }

    if (speed <= UtilityMiningService.DROP_THROW_MAX_SPEED) {
      return "Drop";
    }

    return null;
  }

  private static pathOf(
    points: TrajectoryPoints,
    throwTick: number,
  ): Array<UtilityTrajectoryPoint> {
    const stride = Math.max(
      1,
      Math.ceil(points.length / UtilityLineupsService.MAX_PATH_POINTS),
    );
    const path: Array<UtilityTrajectoryPoint> = [];

    for (let index = 0; index < points.length; index += stride) {
      const point = points[index];
      path.push({
        // Rebased off the throw so the artifact's timeline starts at zero
        // rather than at whatever ingame tick this round happened to be on.
        tick: point.t - throwTick,
        x: point.x,
        y: point.y,
        z: point.z,
      });
    }

    return path;
  }

  private static magnitude(vector: UtilityVector): number {
    return Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
  }

  // Shortest signed arc, so a derived 179 against a recorded -179 reads as two
  // degrees apart rather than 358.
  private static angleDelta(derived: number, recorded: number): number {
    let delta = (derived - recorded) % 360;

    if (delta > 180) {
      delta -= 360;
    }

    if (delta < -180) {
      delta += 360;
    }

    return UtilityMiningService.round(delta);
  }

  private static round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
