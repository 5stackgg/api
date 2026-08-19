import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { UtilityArtifactsService } from "./utility-artifacts.service";
import { UtilityLineupsService } from "./utility-lineups.service";

export type UtilityImportError = {
  index: number;
  external_id: string | null;
  reason: string;
};

export type UtilityImportOutput = {
  dry_run: boolean;
  total: number;
  imported: number;
  updated: number;
  failed: number;
  errors: Array<UtilityImportError>;
};

export type UtilityPurgeOutput = {
  dry_run: boolean;
  origin_source: string;
  lineups: number;
};

type Entry = Record<string, unknown>;

type Lineup = {
  external_id: string;
  map_name: string;
  utility_type: string;
  side: string;
  technique: string;
  throw_strength: string | null;
  jump_throw_bind: boolean;
  origin: { x: number; y: number; z: number };
  land: { x: number; y: number; z: number };
  eye_z: number | null;
  view_yaw: number;
  view_pitch: number;
  flight_time_ms: number | null;
  name: string;
};

// Seeds the library from a file an operator hands over.
//
// A seeded lineup carries no engine seed, so the confidence trigger grades it
// 'low' and it stays unverified until somebody actually lands it -- which is
// the honest reading of a coordinate this platform never watched. The
// coordinate bounds are the ones POST /utility/ingest enforces, shared rather
// than re-stated: numbers out of a file are no more trustworthy than numbers
// out of a game server, and "the same bounds" only holds if it is the same code.
//
// Nothing is written until every entry has been read and judged on its own. One
// unusable row reports itself and the rest of the batch lands.
@Injectable()
export class UtilityImportService {
  // Big enough for a whole library in one call, small enough that the action is
  // a request rather than a job.
  public static readonly MAX_ENTRIES = 5000;
  // A batch that is wrong is wrong in one way, thousands of times over. Past
  // this the list stops being a report and starts being the payload again.
  public static readonly MAX_ERRORS = 200;

  private static readonly UTILITY_TYPES: Record<string, string> = {
    smoke: "Smoke",
    smokegrenade: "Smoke",
    flash: "Flash",
    flashbang: "Flash",
    molotov: "Molotov",
    incendiary: "Molotov",
    incgrenade: "Molotov",
    fire: "Molotov",
    he: "HighExplosive",
    hegrenade: "HighExplosive",
    frag: "HighExplosive",
    grenade: "HighExplosive",
    highexplosive: "HighExplosive",
    decoy: "Decoy",
  };

  private static readonly SIDES: Record<string, string> = {
    t: "TERRORIST",
    tside: "TERRORIST",
    terrorist: "TERRORIST",
    terrorists: "TERRORIST",
    attack: "TERRORIST",
    attacker: "TERRORIST",
    ct: "CT",
    ctside: "CT",
    counterterrorist: "CT",
    counterterrorists: "CT",
    defense: "CT",
    defence: "CT",
    defender: "CT",
  };

  private static readonly TECHNIQUES: Record<string, string> = {
    stationary: "Stationary",
    stand: "Stationary",
    standing: "Stationary",
    still: "Stationary",
    walk: "Walking",
    walking: "Walking",
    run: "Running",
    running: "Running",
    crouch: "Crouch",
    crouching: "Crouch",
    jump: "Jump",
    jumpthrow: "Jump",
    runjump: "RunJump",
    runningjump: "RunJump",
    runthrow: "RunJump",
    walkjump: "WalkJump",
    walkingjump: "WalkJump",
    crouchjump: "CrouchJump",
    crouchingjump: "CrouchJump",
  };

  private static readonly STRENGTHS: Record<string, string> = {
    full: "Full",
    left: "Full",
    leftclick: "Full",
    hard: "Full",
    half: "Half",
    both: "Half",
    medium: "Half",
    drop: "Drop",
    right: "Drop",
    rightclick: "Drop",
    soft: "Drop",
  };

  private static readonly ORIGIN_SOURCE = "import";

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly artifacts: UtilityArtifactsService,
  ) {}

  public async importLineups(
    user: User,
    input: { payload: unknown; dry_run?: boolean | null },
  ): Promise<UtilityImportOutput> {
    await this.assertOperator(user);

    return await this.runImport(user.steam_id, input);
  }

  // The bundled default library. Not an operator import: it carries no
  // utility_import_enabled gate and no administrator, because nobody asked for it
  // -- it is the library an install starts with. Idempotent through the same
  // (origin_source, external_id) upsert, so a restart re-seeds nothing.
  public async seedLineups(
    steamId: string,
    payload: unknown,
  ): Promise<UtilityImportOutput> {
    return await this.runImport(steamId, { payload, dry_run: false });
  }

  private async runImport(
    steamId: string,
    input: { payload: unknown; dry_run?: boolean | null },
  ): Promise<UtilityImportOutput> {
    const dryRun = input.dry_run === true;
    const envelope = UtilityImportService.envelope(input.payload);
    const visibility = UtilityImportService.visibility(envelope.visibility);
    const entries = envelope.entries;

    const output: UtilityImportOutput = {
      dry_run: dryRun,
      total: entries.length,
      imported: 0,
      updated: 0,
      failed: 0,
      errors: [],
    };

    const maps = await this.mapNames();
    const seen = new Set<string>();

    for (const [index, raw] of entries.entries()) {
      let lineup: Lineup;

      try {
        lineup = UtilityImportService.read(raw, maps);
      } catch (error) {
        output.failed += 1;
        UtilityImportService.fail(
          output,
          index,
          UtilityImportService.externalId(raw),
          (error as Error)?.message ?? "unreadable entry",
        );
        continue;
      }

      // Two entries claiming one key would silently overwrite each other and
      // report as one import and one update, which reads as success.
      if (seen.has(lineup.external_id)) {
        output.failed += 1;
        UtilityImportService.fail(
          output,
          index,
          lineup.external_id,
          "another entry in this payload already claims that id",
        );
        continue;
      }

      seen.add(lineup.external_id);

      try {
        const existing = await this.existing(lineup.external_id);

        if (dryRun) {
          if (existing) {
            output.updated += 1;
          } else {
            output.imported += 1;
          }
          continue;
        }

        const inserted = await this.write(
          lineup,
          steamId, visibility);

        if (inserted) {
          output.imported += 1;
        } else {
          output.updated += 1;
        }
      } catch (error) {
        output.failed += 1;
        UtilityImportService.fail(
          output,
          index,
          lineup.external_id,
          (error as Error)?.message ?? "could not be written",
        );
      }
    }

    this.logger.log(
      `[utility-import] ${steamId} ${dryRun ? "previewed" : "seeded"} ` +
        `${output.imported} new, ${output.updated} updated, ${output.failed} failed`,
    );

    return output;
  }

  // The undo. Everything a seeding run wrote shares one origin_source, so
  // removing the run is removing that source -- which is also why this is
  // dry-runnable: 'plugin' is a valid answer to "which source", and it is every
  // lineup any practice server ever recorded.
  public async purgeSource(
    user: User,
    input: { origin_source: string; dry_run?: boolean | null },
  ): Promise<UtilityPurgeOutput> {
    await this.assertOperator(user);

    const source = String(input.origin_source ?? "").trim();
    const dryRun = input.dry_run === true;

    const [known] = await this.postgres.query<Array<{ present: boolean }>>(
      `SELECT EXISTS (
                SELECT 1 FROM public.e_utility_sources s WHERE s.value = $1
              ) AS present`,
      [source],
    );

    if (!known?.present) {
      throw Error(`${source || "that"} is not a lineup source`);
    }

    const [count] = await this.postgres.query<Array<{ lineups: string }>>(
      `SELECT count(*)::text AS lineups
         FROM public.utility_lineups
        WHERE origin_source = $1`,
      [source],
    );

    const lineups = Number(count?.lineups ?? 0);

    if (dryRun || lineups === 0) {
      return { dry_run: dryRun, origin_source: source, lineups };
    }

    // The rows go away either way; the S3 objects only go away if something
    // removes them first. Seeded lineups never have one, so this is empty for
    // the case that motivated the action and correct for the ones that do not.
    const withArtifacts = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id
         FROM public.utility_lineups
        WHERE origin_source = $1 AND trajectory_file IS NOT NULL`,
      [source],
    );

    for (const lineup of withArtifacts) {
      await this.artifacts.removeTrajectories(lineup.id);
    }

    await this.postgres.query(
      "DELETE FROM public.utility_lineups WHERE origin_source = $1",
      [source],
    );

    this.logger.log(
      `[utility-import] ${user.steam_id} purged ${lineups} '${source}' lineup(s)`,
    );

    return { dry_run: false, origin_source: source, lineups };
  }

  private async assertOperator(user: User): Promise<void> {
    if (!user || !isRoleAbove(user.role, "administrator")) {
      throw Error("only an administrator can seed the utility library");
    }

    const [row] = await this.postgres.query<Array<{ value: string }>>(
      "SELECT value FROM public.settings WHERE name = $1 LIMIT 1",
      [SystemSettingName.UtilityImportEnabled],
    );

    if (row?.value !== "true") {
      throw Error("lineup importing is disabled");
    }
  }

  private async mapNames(): Promise<Set<string>> {
    const rows = await this.postgres.query<Array<{ name: string }>>(
      "SELECT DISTINCT name FROM public.maps",
    );

    return new Set(rows.map((row) => row.name));
  }

  private async existing(externalId: string): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id
         FROM public.utility_lineups
        WHERE origin_source = $1 AND external_id = $2`,
      [UtilityImportService.ORIGIN_SOURCE, externalId],
    );

    return row?.id ?? null;
  }

  // Returns true when the row was created rather than refreshed. xmax is zero
  // on a tuple this statement inserted and non-zero on one it updated, which is
  // the only way an upsert can say which of the two it did.
  private async write(
    lineup: Lineup,
    steamId: string,
    visibility: string,
  ): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ inserted: boolean }>>(
      `INSERT INTO public.utility_lineups
         (map_name, utility_type, side, technique, throw_strength, jump_throw_bind,
          origin_x, origin_y, origin_z, eye_z, view_yaw, view_pitch,
          land_x, land_y, land_z, flight_time_ms,
          name, visibility, author_steam_id,
          origin_source, external_id, confidence)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16,
               $17, $18, $19::bigint,
               $20, $21, 'low')
       ON CONFLICT (origin_source, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET map_name = EXCLUDED.map_name,
                     utility_type = EXCLUDED.utility_type,
                     side = EXCLUDED.side,
                     technique = EXCLUDED.technique,
                     throw_strength = EXCLUDED.throw_strength,
                     jump_throw_bind = EXCLUDED.jump_throw_bind,
                     origin_x = EXCLUDED.origin_x,
                     origin_y = EXCLUDED.origin_y,
                     origin_z = EXCLUDED.origin_z,
                     eye_z = EXCLUDED.eye_z,
                     view_yaw = EXCLUDED.view_yaw,
                     view_pitch = EXCLUDED.view_pitch,
                     land_x = EXCLUDED.land_x,
                     land_y = EXCLUDED.land_y,
                     land_z = EXCLUDED.land_z,
                     flight_time_ms = EXCLUDED.flight_time_ms,
                     name = EXCLUDED.name
       RETURNING (xmax = 0) AS inserted`,
      [
        lineup.map_name,
        lineup.utility_type,
        lineup.side,
        lineup.technique,
        lineup.throw_strength,
        lineup.jump_throw_bind,
        lineup.origin.x,
        lineup.origin.y,
        lineup.origin.z,
        lineup.eye_z,
        lineup.view_yaw,
        lineup.view_pitch,
        lineup.land.x,
        lineup.land.y,
        lineup.land.z,
        lineup.flight_time_ms,
        lineup.name,
        visibility,
        steamId,
        UtilityImportService.ORIGIN_SOURCE,
        lineup.external_id,
      ],
    );

    return row?.inserted === true;
  }

  // The accepted input shape. Deliberately forgiving about spelling and shape
  // and unforgiving about meaning: an entry missing a coordinate or an aim angle
  // is not a lineup somebody could stand on and reproduce, so it is reported
  // rather than filled in with a plausible number.
  //
  //   payload: [ entry, ... ]
  //            | { lineups | entries | utility | data: [ entry, ... ],
  //                visibility?: 'Public' | 'Private' }
  //
  //   entry:   external_id | id | key            (required, string or number)
  //            map_name | map                    (required, an installed map)
  //            utility_type | type | utility | grenade   (required)
  //            side | team                       (default TERRORIST)
  //            technique | movement | throw      (default Stationary)
  //            throw_strength | strength         (optional)
  //            jump_throw_bind | jumpthrow       (optional)
  //            origin | position | from | start  (required) {x,y,z} | [x,y,z]
  //              or origin_x / origin_y / origin_z
  //            land | landing | to | end | target (required, same shapes)
  //              or land_x / land_y / land_z
  //            view | angles | viewangles        {yaw,pitch} | [yaw,pitch]
  //              or view_yaw|yaw and view_pitch|pitch (both required)
  //            eye_z                             (optional)
  //            flight_time_ms                    (optional)
  private static read(raw: unknown, maps: Set<string>): Lineup {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw Error("entry is not an object");
    }

    const entry = raw as Entry;
    const externalId = UtilityImportService.externalId(entry);

    if (!externalId) {
      throw Error("entry has no id to key it on");
    }

    const mapName = String(
      UtilityImportService.pick(entry, ["map_name", "map"]) ?? "",
    ).trim();

    if (!maps.has(mapName)) {
      throw Error(`${mapName || "that map"} is not an installed map`);
    }

    const utilityType = UtilityImportService.classify(
      UtilityImportService.pick(entry, [
        "utility_type",
        "type",
        "utility",
        "utility_type",
        "grenade",
        "grenade_type",
      ]),
      UtilityImportService.UTILITY_TYPES,
      "grenade type",
    );

    const origin = UtilityImportService.vector(
      entry,
      ["origin", "position", "from", "start", "throw_position"],
      "origin",
    );
    const land = UtilityImportService.vector(
      entry,
      ["land", "landing", "to", "end", "target", "land_position"],
      "land",
    );

    if (
      UtilityLineupsService.distance(origin, land) > UtilityLineupsService.MAX_TRAVEL
    ) {
      throw Error(
        "origin and landing are further apart than a grenade travels",
      );
    }

    const angles = UtilityImportService.angles(entry);
    const flightTimeMs = UtilityImportService.optionalNumber(
      UtilityImportService.pick(entry, ["flight_time_ms", "flight_time"]),
      "flight_time_ms",
    );

    if (
      flightTimeMs !== null &&
      (flightTimeMs < UtilityLineupsService.MIN_FLIGHT_MS ||
        flightTimeMs > UtilityLineupsService.MAX_FLIGHT_MS)
    ) {
      throw Error("flight_time_ms is out of range");
    }

    return {
      external_id: externalId,
      map_name: mapName,
      utility_type: utilityType,
      side: UtilityImportService.classifyOr(
        UtilityImportService.pick(entry, ["side", "team"]),
        UtilityImportService.SIDES,
        "side",
        "TERRORIST",
      ),
      technique: UtilityImportService.classifyOr(
        UtilityImportService.pick(entry, [
          "technique",
          "movement",
          "throw",
          "throw_type",
        ]),
        UtilityImportService.TECHNIQUES,
        "technique",
        "Stationary",
      ),
      throw_strength: UtilityImportService.classifyOrNull(
        UtilityImportService.pick(entry, ["throw_strength", "strength"]),
        UtilityImportService.STRENGTHS,
        "throw strength",
      ),
      jump_throw_bind:
        UtilityImportService.pick(entry, [
          "jump_throw_bind",
          "jumpthrow_bind",
          "jumpthrow",
          "jump_throw",
        ]) === true,
      origin,
      land,
      eye_z: UtilityImportService.optionalNumber(
        UtilityImportService.pick(entry, ["eye_z", "eye_height"]),
        "eye_z",
      ),
      view_yaw: angles.yaw,
      view_pitch: angles.pitch,
      flight_time_ms: flightTimeMs,
      // Built out of the entry's own classification and key. A seeded row is
      // identified by what it is and which line of the file it came from.
      name: `${utilityType} ${mapName} (${externalId})`.slice(0, 120),
    };
  }

  private static angles(entry: Entry): { yaw: number; pitch: number } {
    const grouped = UtilityImportService.pick(entry, [
      "view",
      "angles",
      "viewangles",
      "view_angles",
    ]);

    let yaw = UtilityImportService.pick(entry, ["view_yaw", "yaw"]);
    let pitch = UtilityImportService.pick(entry, ["view_pitch", "pitch"]);

    if (Array.isArray(grouped)) {
      // Source order is pitch then yaw, which is the order the engine prints
      // them and the order anything copied out of the game will be in.
      pitch = pitch ?? grouped.at(0);
      yaw = yaw ?? grouped.at(1);
    } else if (grouped && typeof grouped === "object") {
      const record = grouped as Entry;
      yaw = yaw ?? UtilityImportService.pick(record, ["yaw", "y"]);
      pitch = pitch ?? UtilityImportService.pick(record, ["pitch", "x"]);
    }

    if (yaw === null || yaw === undefined) {
      throw Error("entry has no view_yaw");
    }

    if (pitch === null || pitch === undefined) {
      throw Error("entry has no view_pitch");
    }

    const resolvedPitch = UtilityLineupsService.finite(pitch, "view_pitch");

    if (resolvedPitch < -90 || resolvedPitch > 90) {
      throw Error("view_pitch is out of range");
    }

    return {
      yaw: UtilityLineupsService.finite(yaw, "view_yaw"),
      pitch: resolvedPitch,
    };
  }

  private static vector(
    entry: Entry,
    keys: Array<string>,
    label: string,
  ): { x: number; y: number; z: number } {
    const grouped = UtilityImportService.pick(entry, keys);

    if (Array.isArray(grouped)) {
      return UtilityLineupsService.point(
        grouped.at(0),
        grouped.at(1),
        grouped.at(2),
        label,
      );
    }

    if (grouped && typeof grouped === "object") {
      const record = grouped as Entry;
      return UtilityLineupsService.point(record.x, record.y, record.z, label);
    }

    const flat = UtilityImportService.pick(entry, [`${label}_x`]);

    if (flat === null || flat === undefined) {
      throw Error(`entry has no ${label}`);
    }

    return UtilityLineupsService.point(
      flat,
      UtilityImportService.pick(entry, [`${label}_y`]),
      UtilityImportService.pick(entry, [`${label}_z`]),
      label,
    );
  }

  // A spelling this platform does not know is an error rather than a default:
  // filing a molotov as a smoke because the word was unfamiliar is worse than
  // saying so.
  private static classify(
    value: unknown,
    table: Record<string, string>,
    label: string,
  ): string {
    const resolved = UtilityImportService.classifyOrNull(value, table, label);

    if (resolved === null) {
      throw Error(`entry has no ${label}`);
    }

    return resolved;
  }

  private static classifyOr(
    value: unknown,
    table: Record<string, string>,
    label: string,
    fallback: string,
  ): string {
    return UtilityImportService.classifyOrNull(value, table, label) ?? fallback;
  }

  private static classifyOrNull(
    value: unknown,
    table: Record<string, string>,
    label: string,
  ): string | null {
    const key = String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");

    if (!key) {
      return null;
    }

    const resolved = table[key];

    if (!resolved) {
      throw Error(`${String(value)} is not a ${label} this platform knows`);
    }

    return resolved;
  }

  private static optionalNumber(value: unknown, label: string): number | null {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return UtilityLineupsService.finite(value, label);
  }

  private static pick(entry: Entry, keys: Array<string>): unknown {
    for (const key of keys) {
      if (entry[key] !== null && entry[key] !== undefined) {
        return entry[key];
      }
    }

    return null;
  }

  private static externalId(raw: unknown): string | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }

    const value = UtilityImportService.pick(raw as Entry, [
      "external_id",
      "id",
      "key",
    ]);

    if (typeof value !== "string" && typeof value !== "number") {
      return null;
    }

    const id = String(value).trim().slice(0, 200);

    return id.length > 0 ? id : null;
  }

  private static envelope(payload: unknown): {
    entries: Array<unknown>;
    visibility: unknown;
  } {
    if (Array.isArray(payload)) {
      return { entries: UtilityImportService.bounded(payload), visibility: null };
    }

    if (!payload || typeof payload !== "object") {
      throw Error("payload is not a list of lineups");
    }

    const record = payload as Entry;
    const entries = UtilityImportService.pick(record, [
      "lineups",
      "entries",
      "utility",
      "data",
    ]);

    if (!Array.isArray(entries)) {
      throw Error("payload is not a list of lineups");
    }

    return {
      entries: UtilityImportService.bounded(entries),
      visibility: record.visibility,
    };
  }

  private static bounded(entries: Array<unknown>): Array<unknown> {
    if (entries.length > UtilityImportService.MAX_ENTRIES) {
      throw Error(
        `payload holds more than ${UtilityImportService.MAX_ENTRIES} lineups; split it`,
      );
    }

    return entries;
  }

  // Team visibility needs a team, and a seeding run has no team to speak for.
  private static visibility(value: unknown): string {
    const visibility = String(value ?? "Public");

    if (visibility !== "Public" && visibility !== "Private") {
      throw Error("visibility must be Public or Private");
    }

    return visibility;
  }

  private static fail(
    output: UtilityImportOutput,
    index: number,
    externalId: string | null,
    reason: string,
  ): void {
    if (output.errors.length >= UtilityImportService.MAX_ERRORS) {
      return;
    }

    output.errors.push({ index, external_id: externalId, reason });
  }
}
