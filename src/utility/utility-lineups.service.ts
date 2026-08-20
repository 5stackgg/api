import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import {
  UtilityArtifactsService,
  UtilityTrajectoryPoint,
} from "./utility-artifacts.service";

export type UtilityIngestPayload = {
  match_id?: string;
  author_steam_id?: string;
  utility_type?: string;
  side?: string;
  technique?: string;
  throw_strength?: string | null;
  jump_throw_bind?: boolean;
  origin_x?: number;
  origin_y?: number;
  origin_z?: number;
  eye_z?: number | null;
  view_yaw?: number;
  view_pitch?: number;
  land_x?: number;
  land_y?: number;
  land_z?: number;
  // The engine's own seed for the projectile (m_vInitialPosition /
  // m_vInitialVelocity). All six or none: half a seed cannot be re-emitted,
  // and filling the gaps with zeros launches the replay from the world origin.
  initial_pos_x?: number | null;
  initial_pos_y?: number | null;
  initial_pos_z?: number | null;
  initial_vel_x?: number | null;
  initial_vel_y?: number | null;
  initial_vel_z?: number | null;
  flight_time_ms?: number | null;
  name?: string;
  description?: string | null;
  tick_rate?: number;
  path?: Array<{ tick?: number; x?: number; y?: number; z?: number }>;
};

// What the plugin reports after a throw made with a lineup loaded. `success`
// is the plugin's own verdict and is recorded nowhere: the distance is
// recomputed here from the stored lineup, because this is the number that
// moves a player's progress and the game server is not a trusted narrator.
export type UtilityPracticeResultPayload = {
  session_id?: string;
  utility_lineup_id?: string;
  steam_id?: string;
  land_x?: number;
  land_y?: number;
  land_z?: number;
  success?: boolean;
};

export type UtilityPracticeResult = {
  success: boolean;
  distance: number;
  radius: number;
  // Where the throw went wrong, in the throw's own frame rather than the
  // world's. A world-space offset is unreadable to the person who threw it;
  // "80 short" is the same fact and is coaching.
  along: number;
  lateral: number;
  vertical: number;
  attempts: number;
  successes: number;
  current_streak: number;
  best_streak: number;
  mastered_at: Date | null;
};

// A landing offset decomposed onto the axes the throw itself defines.
export type UtilityMissOffset = {
  // Negative is short of the lineup, positive is past it. The dominant error
  // for a grenade, because undershooting is a release-angle problem.
  along: number;
  // Negative is left of the throw, positive is right.
  lateral: number;
  // Negative is below the lineup's landing point, positive is above.
  vertical: number;
};

export type UtilityServerContext = {
  serverId: string;
  matchId: string;
  mapName: string;
  lineupSteamIds: Array<string>;
};

export type UtilityLibraryRow = {
  id: string;
  name: string;
  map_name: string;
  utility_type: string;
  side: string;
  technique: string;
  throw_strength: string | null;
  jump_throw_bind: boolean;
  origin_x: number;
  origin_y: number;
  origin_z: number;
  eye_z: number | null;
  view_yaw: number;
  view_pitch: number;
  land_x: number;
  land_y: number;
  land_z: number;
  // Null means the lineup cannot be replayed exactly -- it was mined from a
  // demo, hand-placed or imported rather than watched by a plugin.
  // On the wire so the plugin can tell an exactly-replayable lineup from one
  // whose seed it must not trust. Seed presence alone is the wrong signal: a
  // derived lineup that happens to carry one would be replayed as exact.
  confidence: string;
  initial_pos_x: number | null;
  initial_pos_y: number | null;
  initial_pos_z: number | null;
  initial_vel_x: number | null;
  initial_vel_y: number | null;
  initial_vel_z: number | null;
  flight_time_ms: number | null;
  visibility: string;
  author_steam_id: string;
};

@Injectable()
export class UtilityLineupsService {
  // A compromised game server can send anything, so every one of these is a
  // hard reject rather than a clamp: a silently corrected lineup is a lineup
  // nobody can reproduce.
  public static readonly MAX_PAYLOAD_BYTES = 64 * 1024;
  public static readonly MAX_COORD = 32768;
  public static readonly MAX_TRAVEL = 6000;
  public static readonly MIN_FLIGHT_MS = 50;
  public static readonly MAX_FLIGHT_MS = 15000;
  public static readonly MAX_PATH_POINTS = 256;
  // sv_maxvelocity is 3500 and a grenade leaves the hand at a few hundred
  // units/sec, so twice the engine's own ceiling is generous and still rejects
  // a seed that is not a velocity at all.
  public static readonly MAX_VELOCITY = 7000;
  public static readonly PER_SERVER_PER_MINUTE = 60;
  public static readonly PER_AUTHOR_PER_MINUTE = 20;
  // A player throwing flat out manages a utility every two or three seconds, and
  // every result is a write. Anything past this is a plugin in a loop.
  public static readonly RESULTS_PER_MINUTE = 60;
  // A CS2 smoke is roughly 144 units across its radius. Landing two thirds of
  // that from the reference still puts the cloud over the gap the lineup
  // exists to cover; past it the chokepoint is open and it is a different
  // smoke, not a sloppy one.
  public static readonly DEFAULT_SUCCESS_RADIUS = 96;
  // Five in a row is the bar a lineup has to clear to be worth calling in a
  // match. One lucky throw is not a lineup you own.
  public static readonly MASTERY_STREAK = 5;
  // Past a quarter turn the recorded aim points into the opposite half-plane
  // from where the grenade actually travelled, so it cannot be this throw's
  // forward axis -- and using it anyway would report every undershoot as an
  // overshoot. Bounces and hand-placed lineups are where this happens.
  private static readonly MAX_AXIS_DISAGREEMENT_DEGREES = 90;
  // Below this the origin and the landing point are the same spot, so the
  // bearing between them is noise and there is nothing to cross-check the
  // recorded aim against.
  private static readonly MIN_AXIS_TRAVEL = 1;
  private static readonly DEFAULT_TICK_RATE = 64;
  // What the plugin path records without a seed: the server still watched the
  // grenade fly, it just cannot re-emit it.
  private static readonly DEFAULT_PLUGIN_CONFIDENCE = "exact";

  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // How a re-solve issued for a drifted lineup names itself on the way out, so
  // the lineup that comes back can be recognised on the way in. The solver's
  // tokenizer keeps [A-Za-z0-9_.-] up to 48 characters, which this fits, and no
  // hand-typed name survives that tokenizer looking like a uuid.
  public static readonly REPAIR_NAME_PREFIX = "repair-";
  private static readonly REPAIR_NAME =
    /^repair-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly artifacts: UtilityArtifactsService,
    private readonly cache: CacheService,
  ) {}

  public async isLibraryEnabled(): Promise<boolean> {
    return (
      (await this.setting(SystemSettingName.UtilityLibraryEnabled)) !== "false"
    );
  }

  // The map is taken from the server's own live match row and never from the
  // payload: a server that lies about its map poisons every other player's
  // library for that map.
  public async serverContext(
    serverId: string,
  ): Promise<UtilityServerContext | null> {
    const [row] = await this.postgres.query<
      Array<{ match_id: string; map_name: string }>
    >(
      `SELECT m.id::text AS match_id, mp.name AS map_name
         FROM public.matches m
         INNER JOIN public.match_maps mm ON mm.match_id = m.id
         INNER JOIN public.maps mp ON mp.id = mm.map_id
        WHERE m.server_id = $1::uuid
          AND m.status NOT IN ('Finished', 'Canceled', 'Forfeit', 'Tie', 'Surrendered')
        ORDER BY mm."order" ASC
        LIMIT 1`,
      [serverId],
    );

    if (!row) {
      // Every utility endpoint resolves through here, so a server with no live
      // match fails all of them at once with a message that does not say which
      // server was asked about.
      this.logger.warn(
        `utility: server ${serverId} has no live match, so it has no map or roster`,
      );
      return null;
    }

    const players = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT mlp.steam_id::text AS steam_id
         FROM public.match_lineup_players mlp
         INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE ml.match_id = $1::uuid
          AND mlp.steam_id IS NOT NULL`,
      [row.match_id],
    );

    return {
      serverId,
      matchId: row.match_id,
      mapName: row.map_name,
      lineupSteamIds: players.map((player) => player.steam_id),
    };
  }

  public async ingest(
    context: UtilityServerContext,
    payload: UtilityIngestPayload,
  ): Promise<{ id: string; trajectory_file: string | null }> {
    const author = String(payload.author_steam_id ?? "");

    if (!/^\d{5,20}$/.test(author)) {
      throw Error("author_steam_id is not a steam id");
    }

    if (!context.lineupSteamIds.includes(author)) {
      throw Error("author is not in this match lineup");
    }

    if (!(await this.playerExists(author))) {
      throw Error("author is not a known player");
    }

    const origin = UtilityLineupsService.point(
      payload.origin_x,
      payload.origin_y,
      payload.origin_z,
      "origin",
    );
    const land = UtilityLineupsService.point(
      payload.land_x,
      payload.land_y,
      payload.land_z,
      "land",
    );

    if (
      UtilityLineupsService.distance(origin, land) > UtilityLineupsService.MAX_TRAVEL
    ) {
      throw Error(
        "origin and landing are further apart than a grenade travels",
      );
    }

    const yaw = UtilityLineupsService.finite(payload.view_yaw, "view_yaw");
    const pitch = UtilityLineupsService.finite(payload.view_pitch, "view_pitch");

    if (pitch < -90 || pitch > 90) {
      throw Error("view_pitch is out of range");
    }

    const flightTimeMs =
      payload.flight_time_ms === null || payload.flight_time_ms === undefined
        ? null
        : UtilityLineupsService.finite(payload.flight_time_ms, "flight_time_ms");

    if (
      flightTimeMs !== null &&
      (flightTimeMs < UtilityLineupsService.MIN_FLIGHT_MS ||
        flightTimeMs > UtilityLineupsService.MAX_FLIGHT_MS)
    ) {
      throw Error("flight_time_ms is out of range");
    }

    const path = this.trajectory(payload.path);

    const eyeZ =
      payload.eye_z === null || payload.eye_z === undefined
        ? null
        : UtilityLineupsService.finite(payload.eye_z, "eye_z");

    const seed = this.seed(payload);

    await this.assertRateLimits(context, author);

    const repair = await this.claimableRepair(
      payload.name,
      author,
      context.mapName,
    );

    const [inserted] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.utility_lineups
         (map_name, utility_type, side, technique, throw_strength, jump_throw_bind,
          origin_x, origin_y, origin_z, eye_z, view_yaw, view_pitch,
          land_x, land_y, land_z, flight_time_ms,
          initial_pos_x, initial_pos_y, initial_pos_z,
          initial_vel_x, initial_vel_y, initial_vel_z,
          name, description, visibility, author_steam_id,
          origin_source, source_match_id, confidence, trajectory_preview,
          forked_from_utility_lineup_id)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16,
               $17, $18, $19, $20, $21, $22,
               $23, $24, 'Private', $25,
               'plugin', $26::uuid, $27, $28::jsonb,
               $29::uuid)
       RETURNING id::text AS id`,
      [
        context.mapName,
        payload.utility_type,
        payload.side,
        payload.technique,
        payload.throw_strength ?? null,
        payload.jump_throw_bind === true,
        origin.x,
        origin.y,
        origin.z,
        eyeZ,
        yaw,
        pitch,
        land.x,
        land.y,
        land.z,
        flightTimeMs,
        seed?.position.x ?? null,
        seed?.position.y ?? null,
        seed?.position.z ?? null,
        seed?.velocity.x ?? null,
        seed?.velocity.y ?? null,
        seed?.velocity.z ?? null,
        // A repaired lineup inherits the drifted one's name. The name it
        // arrived under is the correlation id, and nobody wants a library full
        // of rows called repair-<uuid>.
        repair
          ? repair.lineup_name
          : UtilityLineupsService.sanitizeName(payload.name, context.mapName),
        UtilityLineupsService.sanitizeText(payload.description, 1000),
        author,
        context.matchId,
        // A seed is the engine's own starting state, so the throw can be
        // reproduced rather than approximated. Without one the recording is
        // still the server's own measurement, so it keeps the confidence the
        // source implies rather than being downgraded.
        seed ? "exact" : UtilityLineupsService.DEFAULT_PLUGIN_CONFIDENCE,
        JSON.stringify(UtilityLineupsService.preview(path)),
        repair?.utility_lineup_id ?? null,
      ],
    );

    if (repair) {
      await this.completeRepair(repair.id, inserted.id);
    }

    let trajectoryFile: string | null = null;

    if (path.length > 0) {
      trajectoryFile = await this.artifacts.uploadTrajectory({
        lineupId: inserted.id,
        mapName: context.mapName,
        utilityType: String(payload.utility_type),
        throwerSteamId: author,
        throwerTeam: String(payload.side ?? ""),
        origin,
        land,
        initialPosition: seed?.position ?? null,
        initialVelocity: seed?.velocity ?? null,
        flightTimeMs,
        tickRate: Number.isFinite(payload.tick_rate)
          ? Number(payload.tick_rate)
          : UtilityLineupsService.DEFAULT_TICK_RATE,
        path,
      });
    }

    return { id: inserted.id, trajectory_file: trajectoryFile };
  }

  public async library(
    context: UtilityServerContext,
    steamId: string,
  ): Promise<Array<UtilityLibraryRow>> {
    if (!context.lineupSteamIds.includes(steamId)) {
      this.logger.warn(
        `utility library refused ${steamId} on server ${context.serverId}: ` +
          `not in match ${context.matchId} (roster: ${context.lineupSteamIds.join(", ") || "empty"})`,
      );
      throw Error("player is not in this match lineup");
    }

    const rows = await this.postgres.query<Array<UtilityLibraryRow>>(
      `SELECT l.id::text AS id, l.name, l.map_name, l.utility_type, l.side,
              l.technique, l.throw_strength, l.jump_throw_bind,
              l.origin_x, l.origin_y, l.origin_z, l.eye_z,
              l.view_yaw, l.view_pitch, l.land_x, l.land_y, l.land_z,
              l.initial_pos_x, l.initial_pos_y, l.initial_pos_z,
              l.initial_vel_x, l.initial_vel_y, l.initial_vel_z,
              l.flight_time_ms, l.visibility, l.confidence,
              l.author_steam_id::text AS author_steam_id
         FROM public.utility_lineups l
        WHERE l.map_name = $1
          AND l.archived_at IS NULL
          AND (
            l.author_steam_id = $2::bigint
            OR (l.visibility = 'Team' AND public.is_utility_team_member(l.team_id, $2::bigint))
            OR EXISTS (
              SELECT 1
                FROM public.utility_collection_items ci
                INNER JOIN public.utility_collections c ON c.id = ci.collection_id
               WHERE ci.utility_lineup_id = l.id
                 AND (
                   c.owner_steam_id = $2::bigint
                   OR (c.visibility = 'Team' AND public.is_utility_team_member(c.team_id, $2::bigint))
                 )
            )
            OR EXISTS (
              SELECT 1 FROM public.utility_lineup_favorites f
               WHERE f.utility_lineup_id = l.id AND f.steam_id = $2::bigint
            )
          )
        ORDER BY l.created_at DESC
        LIMIT 500`,
      [context.mapName, steamId],
    );

    // The map is the match's, not the one the server is standing on, so an
    // empty answer usually means those two have drifted apart rather than that
    // the player has nothing saved. Say which map was actually asked for.
    if (rows.length === 0) {
      const [mine] = await this.postgres.query<Array<{ maps: string }>>(
        `SELECT COALESCE(string_agg(DISTINCT l.map_name, ', '), 'none') AS maps
           FROM public.utility_lineups l
          WHERE l.author_steam_id = $1::bigint
            AND l.archived_at IS NULL`,
        [steamId],
      );

      this.logger.warn(
        `utility library empty for ${steamId} on match ${context.matchId}: ` +
          `asked for map "${context.mapName}", that player has lineups on: ${mine?.maps ?? "none"}`,
      );
    } else {
      this.logger.log(
        `utility library sent ${rows.length} lineup(s) for ${steamId} on "${context.mapName}"`,
      );
    }

    return rows;
  }

  // The flight path of one lineup the library already handed this player. The
  // roster check and the visibility clause are the library's, not a weaker
  // pair: a practice server may only read a path on behalf of somebody it is
  // actually hosting, and only for a lineup that player can already see.
  public async trajectoryFile(
    context: UtilityServerContext,
    steamId: string,
    lineupId: string,
  ): Promise<string | null> {
    if (!context.lineupSteamIds.includes(steamId)) {
      throw Error("player is not in this match lineup");
    }

    const [row] = await this.postgres.query<
      Array<{ trajectory_file: string | null }>
    >(
      `SELECT l.trajectory_file
         FROM public.utility_lineups l
        WHERE l.id = $1::uuid
          AND public.can_view_utility_lineup(
                l,
                json_build_object(
                  'x-hasura-role', 'user',
                  'x-hasura-user-id', $2::text
                )
              )`,
      [lineupId, steamId],
    );

    return row?.trajectory_file ?? null;
  }

  // Scores one throw against the lineup that was loaded. The plugin's own
  // verdict is never what moves the counters: the distance is recomputed from
  // the stored landing point, so a compromised server can at worst report a
  // throw that did not happen, not a throw that did not land.
  public async recordPracticeResult(
    context: UtilityServerContext,
    payload: UtilityPracticeResultPayload,
  ): Promise<UtilityPracticeResult> {
    const steamId = String(payload.steam_id ?? "");

    if (!/^\d{5,20}$/.test(steamId)) {
      throw Error("steam_id is not a steam id");
    }

    if (!context.lineupSteamIds.includes(steamId)) {
      throw Error("player is not in this match lineup");
    }

    const lineupId = String(payload.utility_lineup_id ?? "");

    if (!UtilityLineupsService.UUID.test(lineupId)) {
      throw Error("utility_lineup_id is not a lineup");
    }

    const land = UtilityLineupsService.point(
      payload.land_x,
      payload.land_y,
      payload.land_z,
      "land",
    );

    await this.assertResultRateLimit(context.serverId, steamId);

    const [lineup] = await this.postgres.query<
      Array<{
        origin_x: number;
        origin_y: number;
        view_yaw: number;
        land_x: number;
        land_y: number;
        land_z: number;
        map_name: string;
        visible: boolean;
      }>
    >(
      `SELECT l.origin_x, l.origin_y, l.view_yaw,
              l.land_x, l.land_y, l.land_z, l.map_name,
              public.can_view_utility_lineup(l, $2::json) AS visible
         FROM public.utility_lineups l
        WHERE l.id = $1::uuid`,
      [
        lineupId,
        JSON.stringify({
          "x-hasura-role": "user",
          "x-hasura-user-id": steamId,
        }),
      ],
    );

    if (!lineup || !lineup.visible) {
      throw Error("lineup not found");
    }

    if (lineup.map_name !== context.mapName) {
      throw Error("that lineup is not on this map");
    }

    const radius = await this.successRadius();
    const distance = UtilityLineupsService.distance(land, {
      x: Number(lineup.land_x),
      y: Number(lineup.land_y),
      z: Number(lineup.land_z),
    });
    const success = distance <= radius;
    // Recorded for every throw, hit or miss. The pattern this feeds is a
    // distribution of landing offsets, not a log of failures: dropping the
    // hits would truncate it at the success radius, so a lineup the whole
    // platform lands 60 units short of -- a real release-angle bias, and most
    // of a smoke's width -- would come back as "no pattern", and the only
    // people left in the sample would be the ones who cannot throw it.
    const offset = UtilityLineupsService.decomposeMiss(lineup, land);

    if (payload.success === true && !success) {
      this.logger.warn(
        `[utility-practice ${context.serverId}] plugin scored a hit on ${lineupId} that landed ${distance.toFixed(1)} units away`,
      );
    }

    const [progress] = await this.postgres.query<
      Array<{
        attempts: number;
        successes: number;
        current_streak: number;
        best_streak: number;
        mastered_at: Date | null;
      }>
    >(
      `INSERT INTO public.utility_lineup_progress
         (utility_lineup_id, steam_id, attempts, successes, current_streak,
          best_streak, last_practiced_at, mastered_at,
          miss_samples, miss_along_sum, miss_lateral_sum, miss_vertical_sum)
       VALUES ($1::uuid, $2::bigint, 1, $3::int, $3::int, $3::int, now(),
               CASE WHEN $3::int >= $4::int THEN now() END,
               1, $5::float8, $6::float8, $7::float8)
       ON CONFLICT (utility_lineup_id, steam_id) DO UPDATE
          SET attempts = utility_lineup_progress.attempts + 1,
              successes = utility_lineup_progress.successes + $3::int,
              current_streak = CASE WHEN $3::int = 1
                                    THEN utility_lineup_progress.current_streak + 1
                                    ELSE 0 END,
              best_streak = GREATEST(
                  utility_lineup_progress.best_streak,
                  CASE WHEN $3::int = 1
                       THEN utility_lineup_progress.current_streak + 1
                       ELSE 0 END),
              last_practiced_at = now(),
              -- Mastery is the first time the bar was cleared. COALESCE keeps
              -- it there: a later miss resets the streak, not the fact.
              mastered_at = COALESCE(
                  utility_lineup_progress.mastered_at,
                  CASE WHEN $3::int = 1
                            AND utility_lineup_progress.current_streak + 1 >= $4::int
                       THEN now() END),
              miss_samples = utility_lineup_progress.miss_samples + 1,
              miss_along_sum = utility_lineup_progress.miss_along_sum + $5::float8,
              miss_lateral_sum = utility_lineup_progress.miss_lateral_sum + $6::float8,
              miss_vertical_sum = utility_lineup_progress.miss_vertical_sum + $7::float8
       RETURNING attempts, successes, current_streak, best_streak, mastered_at`,
      [
        lineupId,
        steamId,
        success ? 1 : 0,
        UtilityLineupsService.MASTERY_STREAK,
        offset.along,
        offset.lateral,
        offset.vertical,
      ],
    );

    return {
      success,
      distance: Math.round(distance * 10) / 10,
      radius,
      along: UtilityLineupsService.tenth(offset.along),
      lateral: UtilityLineupsService.tenth(offset.lateral),
      vertical: UtilityLineupsService.tenth(offset.vertical),
      attempts: Number(progress.attempts),
      successes: Number(progress.successes),
      current_streak: Number(progress.current_streak),
      best_streak: Number(progress.best_streak),
      mastered_at: progress.mastered_at,
    };
  }

  public async successRadius(): Promise<number> {
    const configured = Number(
      await this.setting(SystemSettingName.UtilitySuccessRadius),
    );

    if (!Number.isFinite(configured) || configured <= 0) {
      return UtilityLineupsService.DEFAULT_SUCCESS_RADIUS;
    }

    return configured;
  }

  public async deleteLineup(lineupId: string, steamId: string): Promise<void> {
    const [row] = await this.postgres.query<
      Array<{ id: string; author_steam_id: string }>
    >(
      `SELECT id::text AS id, author_steam_id::text AS author_steam_id
         FROM public.utility_lineups WHERE id = $1::uuid`,
      [lineupId],
    );

    if (!row) {
      throw Error("lineup not found");
    }

    if (row.author_steam_id !== steamId) {
      throw Error("you did not author this lineup");
    }

    await this.artifacts.removeTrajectories(lineupId);
    await this.postgres.query(
      "DELETE FROM public.utility_lineups WHERE id = $1::uuid",
      [lineupId],
    );
  }

  // Promotes a lineup the plugin already recorded inside this session. The
  // geometry is never taken from the caller: it only ever comes off the server
  // that watched the grenade fly.
  public async saveFromPractice(options: {
    steamId: string;
    matchId: string;
    lineupId: string;
    name: string;
    description?: string | null;
    visibility?: string;
    teamId?: string | null;
    tags?: Array<string>;
    collectionId?: string | null;
  }): Promise<{ id: string }> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id FROM public.utility_lineups
        WHERE id = $1::uuid
          AND source_match_id = $2::uuid
          AND author_steam_id = $3::bigint`,
      [options.lineupId, options.matchId, options.steamId],
    );

    if (!row) {
      throw Error("that lineup was not recorded in this practice session");
    }

    await this.assertDailyLineupLimit(options.steamId);

    await this.postgres.query(
      `UPDATE public.utility_lineups
          SET name = $2,
              description = $3,
              visibility = $4,
              team_id = $5::uuid,
              tags = $6::text[]
        WHERE id = $1::uuid`,
      [
        options.lineupId,
        UtilityLineupsService.sanitizeName(options.name, "Lineup"),
        UtilityLineupsService.sanitizeText(options.description, 1000),
        options.visibility ?? "Private",
        options.teamId ?? null,
        (options.tags ?? [])
          .slice(0, 16)
          .map((tag) => String(tag).slice(0, 40)),
      ],
    );

    if (options.collectionId) {
      await this.postgres.query(
        `INSERT INTO public.utility_collection_items (collection_id, utility_lineup_id)
         SELECT $1::uuid, $2::uuid
          WHERE EXISTS (
            SELECT 1 FROM public.utility_collections c
             WHERE c.id = $1::uuid AND c.owner_steam_id = $3::bigint
          )
         ON CONFLICT DO NOTHING`,
        [options.collectionId, options.lineupId, options.steamId],
      );
    }

    return { id: options.lineupId };
  }

  // Copies a lineup the caller can see into their own library.
  //
  // What crosses is the throw itself -- where you stand, where you look, where
  // it lands, how it is classified, and the engine seed if the original had
  // one. A seed is the starting state of a projectile, not a credential: the
  // copy is exactly as replayable as the original, which is the entire reason
  // to fork a good lineup rather than re-measure it.
  //
  // What does not cross is everything the community said about the original and
  // everything that says where it came from: votes, favourites, practice
  // progress, a moderator's verified_at, the source match and grenade, and the
  // external id. The fork's own provenance is forked_from_utility_lineup_id plus
  // origin_source 'fork', so a copy can never pass itself off as the recording.
  //
  // The confidence is carried verbatim rather than reset. It is a claim about
  // whether these coordinates were measured, and copying them does not un-
  // measure them -- tbiu_utility_lineups treats 'fork' as an origin that may hold
  // 'exact' for exactly that reason, and demotes anything weaker on its own.
  public async fork(
    user: User,
    input: {
      utility_lineup_id: string;
      name?: string | null;
      collection_id?: string | null;
    },
  ): Promise<{ id: string }> {
    if (!(await this.isLibraryEnabled())) {
      throw Error("the utility library is disabled");
    }

    const sourceId = String(input.utility_lineup_id ?? "");

    if (!UtilityLineupsService.UUID.test(sourceId)) {
      throw Error("lineup not found");
    }

    await this.assertDailyLineupLimit(user.steam_id);

    const [forked] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.utility_lineups
         (map_name, workshop_map_id, utility_type, side, technique, throw_strength,
          jump_throw_bind, origin_x, origin_y, origin_z, eye_z,
          view_yaw, view_pitch, view_yaw_delta, view_pitch_delta,
          land_x, land_y, land_z, flight_time_ms,
          initial_pos_x, initial_pos_y, initial_pos_z,
          initial_vel_x, initial_vel_y, initial_vel_z,
          name, description, tags, visibility, author_steam_id,
          origin_source, forked_from_utility_lineup_id, confidence,
          trajectory_preview)
       SELECT l.map_name, l.workshop_map_id, l.utility_type, l.side, l.technique,
              l.throw_strength, l.jump_throw_bind,
              l.origin_x, l.origin_y, l.origin_z, l.eye_z,
              l.view_yaw, l.view_pitch, l.view_yaw_delta, l.view_pitch_delta,
              l.land_x, l.land_y, l.land_z, l.flight_time_ms,
              l.initial_pos_x, l.initial_pos_y, l.initial_pos_z,
              l.initial_vel_x, l.initial_vel_y, l.initial_vel_z,
              COALESCE($2, l.name), l.description, l.tags, 'Private',
              $3::bigint, 'fork', l.id, l.confidence, l.trajectory_preview
         FROM public.utility_lineups l
        WHERE l.id = $1::uuid
          AND public.can_view_utility_lineup(l, $4::json)
       RETURNING id::text AS id`,
      [
        sourceId,
        UtilityLineupsService.sanitizeText(input.name, 120),
        user.steam_id,
        JSON.stringify({
          "x-hasura-role": user.role,
          "x-hasura-user-id": user.steam_id,
        }),
      ],
    );

    if (!forked) {
      throw Error("lineup not found");
    }

    if (input.collection_id) {
      await this.postgres.query(
        `INSERT INTO public.utility_collection_items (collection_id, utility_lineup_id)
         SELECT $1::uuid, $2::uuid
          WHERE EXISTS (
            SELECT 1 FROM public.utility_collections c
             WHERE c.id = $1::uuid AND c.owner_steam_id = $3::bigint
          )
         ON CONFLICT DO NOTHING`,
        [input.collection_id, forked.id, user.steam_id],
      );
    }

    return { id: forked.id };
  }

  public async assertDailyLineupLimit(steamId: string): Promise<void> {
    const limit = Number(
      (await this.setting(SystemSettingName.UtilityLineupDailyLimit)) ?? "200",
    );

    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    const [row] = await this.postgres.query<Array<{ count: string }>>(
      `SELECT COUNT(*) AS count FROM public.utility_lineups
        WHERE author_steam_id = $1::bigint
          AND created_at > now() - interval '1 day'`,
      [steamId],
    );

    if (Number(row.count) > limit) {
      throw Error("you have saved too many lineups today");
    }
  }

  // The ingest limits count rows written in the last minute; a practice result
  // writes no row of its own -- it increments a counter -- so there is nothing
  // to count. The minute is part of the key rather than the TTL: re-setting a
  // TTL on every throw would push the window out in front of a player who
  // never stops throwing, and they would never be let back in.
  private async assertResultRateLimit(
    serverId: string,
    steamId: string,
  ): Promise<void> {
    const key = `utility-result:${serverId}:${steamId}:${Math.floor(
      Date.now() / 60000,
    )}`;
    const count = Number(await this.cache.get(key, 0)) + 1;

    await this.cache.put(key, count, 120);

    if (count > UtilityLineupsService.RESULTS_PER_MINUTE) {
      throw Error("you are throwing too quickly");
    }
  }

  private async assertRateLimits(
    context: UtilityServerContext,
    author: string,
  ): Promise<void> {
    const [row] = await this.postgres.query<
      Array<{ per_server: string; per_author: string }>
    >(
      `SELECT
         COUNT(*) FILTER (WHERE source_match_id = $1::uuid) AS per_server,
         COUNT(*) FILTER (WHERE author_steam_id = $2::bigint) AS per_author
        FROM public.utility_lineups
       WHERE created_at > now() - interval '1 minute'
         AND (source_match_id = $1::uuid OR author_steam_id = $2::bigint)`,
      [context.matchId, author],
    );

    if (Number(row.per_server) >= UtilityLineupsService.PER_SERVER_PER_MINUTE) {
      throw Error("this server is ingesting lineups too quickly");
    }

    if (Number(row.per_author) >= UtilityLineupsService.PER_AUTHOR_PER_MINUTE) {
      throw Error("you are recording lineups too quickly");
    }

    await this.assertDailyLineupLimit(author);
  }

  // A repair asked the solver for a throw onto a drifted lineup's own landing
  // point. The solve answers minutes later by posting an ordinary lineup here,
  // and the only field that survives that round trip is the name the plugin was
  // handed -- so the name carries the correlation id and this is where it is
  // spent. Nothing about the incoming lineup is trusted beyond the id: the row
  // is written exactly as any other plugin recording, and the claim only adds
  // the link back to what it repaired.
  private async claimableRepair(
    name: unknown,
    author: string,
    mapName: string,
  ): Promise<{
    id: string;
    utility_lineup_id: string;
    lineup_name: string;
  } | null> {
    const repairId = UtilityLineupsService.repairIdFromName(name);

    if (!repairId) {
      return null;
    }

    const [row] = await this.postgres.query<
      Array<{ id: string; utility_lineup_id: string; lineup_name: string }>
    >(
      `SELECT r.id::text AS id,
              r.utility_lineup_id::text AS utility_lineup_id,
              l.name AS lineup_name
         FROM public.utility_lineup_repairs r
         INNER JOIN public.utility_lineups l ON l.id = r.utility_lineup_id
        WHERE r.id = $1::uuid
          AND r.status = 'Requested'
          AND r.expires_at > now()
          AND r.requested_by_steam_id = $2::bigint
          AND l.map_name = $3`,
      [repairId, author, mapName],
    );

    return row ?? null;
  }

  private async completeRepair(
    repairId: string,
    lineupId: string,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_lineup_repairs
          SET status = 'Repaired',
              repaired_utility_lineup_id = $2::uuid,
              repaired_at = now()
        WHERE id = $1::uuid AND status = 'Requested'`,
      [repairId, lineupId],
    );
  }

  public static repairName(repairId: string): string {
    return `${UtilityLineupsService.REPAIR_NAME_PREFIX}${repairId}`;
  }

  private static repairIdFromName(name: unknown): string | null {
    return (
      String(name ?? "")
        .trim()
        .match(UtilityLineupsService.REPAIR_NAME)
        ?.at(1) ?? null
    );
  }

  private async playerExists(steamId: string): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ present: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM public.players WHERE steam_id = $1::bigint) AS present`,
      [steamId],
    );
    return row?.present === true;
  }

  private async setting(name: string): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      "SELECT value FROM public.settings WHERE name = $1 LIMIT 1",
      [name],
    );
    return row?.value ?? null;
  }

  private trajectory(
    path: UtilityIngestPayload["path"],
  ): Array<UtilityTrajectoryPoint> {
    if (!path) {
      return [];
    }

    if (!Array.isArray(path)) {
      throw Error("path is not an array");
    }

    if (path.length > UtilityLineupsService.MAX_PATH_POINTS) {
      throw Error("path has too many points");
    }

    return path.map((point, index) => {
      const resolved = UtilityLineupsService.point(
        point?.x,
        point?.y,
        point?.z,
        `path[${index}]`,
      );
      return {
        tick: Number.isFinite(point?.tick) ? Number(point.tick) : index,
        ...resolved,
      };
    });
  }

  // All six or none. A partial seed cannot be re-emitted, and completing it
  // with zeros is worse than refusing it: the plugin would replay the throw
  // from the world origin.
  private seed(payload: UtilityIngestPayload): {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
  } | null {
    const parts = [
      payload.initial_pos_x,
      payload.initial_pos_y,
      payload.initial_pos_z,
      payload.initial_vel_x,
      payload.initial_vel_y,
      payload.initial_vel_z,
    ];
    const given = parts.filter(
      (part) => part !== null && part !== undefined,
    ).length;

    if (given === 0) {
      return null;
    }

    if (given !== parts.length) {
      throw Error("the physics seed is incomplete");
    }

    const position = UtilityLineupsService.point(
      payload.initial_pos_x,
      payload.initial_pos_y,
      payload.initial_pos_z,
      "initial_pos",
    );

    const velocity = {
      x: UtilityLineupsService.finite(payload.initial_vel_x, "initial_vel_x"),
      y: UtilityLineupsService.finite(payload.initial_vel_y, "initial_vel_y"),
      z: UtilityLineupsService.finite(payload.initial_vel_z, "initial_vel_z"),
    };

    // A velocity is not a position, so it is bounded on magnitude rather than
    // by the map's extents.
    const speed = Math.sqrt(
      velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2,
    );

    if (speed > UtilityLineupsService.MAX_VELOCITY) {
      throw Error("initial velocity is faster than the engine allows");
    }

    return { position, velocity };
  }

  // Static and public because these bounds are the definition of a coordinate
  // this platform will store, not a property of the ingest request that first
  // needed them. Any other door that writes a lineup has to reject exactly what
  // ingest rejects, and the only way to guarantee "exactly" is to share the code.
  public static point(
    x: unknown,
    y: unknown,
    z: unknown,
    label: string,
  ): { x: number; y: number; z: number } {
    return {
      x: UtilityLineupsService.coord(x, `${label}.x`),
      y: UtilityLineupsService.coord(y, `${label}.y`),
      z: UtilityLineupsService.coord(z, `${label}.z`),
    };
  }

  public static coord(value: unknown, label: string): number {
    const resolved = UtilityLineupsService.finite(value, label);

    if (Math.abs(resolved) > UtilityLineupsService.MAX_COORD) {
      throw Error(`${label} is outside the map`);
    }

    return resolved;
  }

  public static finite(value: unknown, label: string): number {
    const resolved = Number(value);

    if (!Number.isFinite(resolved)) {
      throw Error(`${label} is not a finite number`);
    }

    return resolved;
  }

  public static distance(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
  ): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }

  // The + 0 is what turns -0 back into 0. Rounding a hair below zero -- which
  // is what a sin/cos of a right angle leaves on the axis the throw did not
  // miss on -- otherwise reports a dead-straight throw as "-0 left".
  private static tenth(value: number): number {
    return Math.round(value * 10) / 10 + 0;
  }

  // Turns "you landed 74 units from the lineup" into "you landed 70 short and
  // 20 right of it", which is the difference between a score and a lesson.
  //
  // The frame is the throw's, not the world's. Source yaw is degrees
  // counter-clockwise from +X, so forward is (cos yaw, sin yaw) and the right
  // vector at zero roll is (sin yaw, -cos yaw) -- the same basis AngleVectors
  // builds in the engine, which is what makes "left" the player's left.
  public static decomposeMiss(
    lineup: {
      origin_x: number;
      origin_y: number;
      view_yaw: number;
      land_x: number;
      land_y: number;
      land_z: number;
    },
    land: { x: number; y: number; z: number },
  ): UtilityMissOffset {
    const yaw = (UtilityLineupsService.throwAxis(lineup) * Math.PI) / 180;
    const forwardX = Math.cos(yaw);
    const forwardY = Math.sin(yaw);

    const dx = land.x - Number(lineup.land_x);
    const dy = land.y - Number(lineup.land_y);

    return {
      along: dx * forwardX + dy * forwardY,
      lateral: dx * forwardY - dy * forwardX,
      vertical: land.z - Number(lineup.land_z),
    };
  }

  // view_yaw is where the thrower was looking, which is the axis a release-angle
  // error runs along and therefore the one to decompose onto. It is only
  // believed when it agrees with where the grenade actually ended up: a lineup
  // that was hand-placed, imported, or mined from a demo can carry a yaw that
  // has nothing to do with its own landing point, and a forward axis pointing
  // the wrong way does not fail loudly -- it reports every undershoot as an
  // overshoot.
  private static throwAxis(lineup: {
    origin_x: number;
    origin_y: number;
    view_yaw: number;
    land_x: number;
    land_y: number;
  }): number {
    const yaw = Number(lineup.view_yaw);
    const dx = Number(lineup.land_x) - Number(lineup.origin_x);
    const dy = Number(lineup.land_y) - Number(lineup.origin_y);
    const travel = Math.sqrt(dx ** 2 + dy ** 2);

    if (travel < UtilityLineupsService.MIN_AXIS_TRAVEL) {
      return Number.isFinite(yaw) ? yaw : 0;
    }

    const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;

    if (!Number.isFinite(yaw)) {
      return bearing;
    }

    const disagreement = Math.abs(
      ((((yaw - bearing) % 360) + 540) % 360) - 180,
    );

    return disagreement > UtilityLineupsService.MAX_AXIS_DISAGREEMENT_DEGREES
      ? bearing
      : yaw;
  }

  // Up to 32 quantized points so the library grid renders a thumbnail straight
  // out of one GraphQL query; the full path only ever lives in S3.
  public static preview(
    path: Array<UtilityTrajectoryPoint>,
  ): Array<[number, number, number]> {
    if (path.length === 0) {
      return [];
    }

    const step = Math.max(1, Math.ceil(path.length / 32));
    const preview: Array<[number, number, number]> = [];

    for (let index = 0; index < path.length; index += step) {
      const point = path[index];
      preview.push([
        Math.round(point.x),
        Math.round(point.y),
        Math.round(point.z),
      ]);
    }

    return preview;
  }

  public static sanitizeName(
    value: string | undefined,
    fallback: string,
  ): string {
    const name = UtilityLineupsService.sanitizeText(value, 120);
    return name && name.length > 0 ? name : fallback;
  }

  public static sanitizeText(
    value: string | null | undefined,
    max: number,
  ): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    // Control characters would end up rendered verbatim in the web library and
    // echoed back into the game chat by the plugin.
    const cleaned = String(value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, max);

    return cleaned.length > 0 ? cleaned : null;
  }
}
