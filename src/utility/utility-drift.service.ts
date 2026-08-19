import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DemoParserService,
  ParsedDriftLineup,
  ParsedDriftResult,
} from "../demos/demo-parser.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AppConfig } from "../configs/types/AppConfig";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "../../generated";
import { User } from "../auth/types/User";
import { isRoleAbove } from "../utilities/isRoleAbove";

export type UtilityDriftScanOutput = {
  scan_id: string;
  lineups: number;
};

type SeededLineup = {
  id: string;
  utility_type: string;
  initial_pos_x: number | null;
  initial_pos_y: number | null;
  initial_pos_z: number | null;
  initial_vel_x: number | null;
  initial_vel_y: number | null;
  initial_vel_z: number | null;
};

// Re-flies a map's lineups against two collision meshes and records what moved.
//
// Everything this writes is DIFFERENTIAL. The simulator's absolute endpoints
// are meaningless -- an unfitted physics model puts the same error on both runs
// and only the gap between them survives -- so a verdict and a distance are all
// that is kept, and no coordinate from it may ever be shown as "where your utility
// lands".
@Injectable()
export class UtilityDriftService {
  // The parser buffers up to 2000 lineups per request and serializes itself
  // (it holds two meshes at once). 500 is the safe batch: small enough that a
  // failure costs one round trip, big enough that a busy map is a handful of
  // them rather than hundreds.
  public static readonly BATCH_SIZE = 500;

  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly demoParser: DemoParserService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  public async startScan(
    user: User,
    input: {
      map_name: string;
      from_revision?: string | null;
      to_revision?: string | null;
    },
  ): Promise<UtilityDriftScanOutput> {
    if (!user || !isRoleAbove(user.role, "administrator")) {
      throw Error("only an administrator can scan a map for drift");
    }

    const mapName = String(input.map_name ?? "").trim();

    if (!mapName) {
      throw Error("map_name is required");
    }

    const [{ lineups }] = await this.postgres.query<Array<{ lineups: string }>>(
      `SELECT count(*)::text AS lineups
         FROM public.utility_lineups
        WHERE map_name = $1 AND archived_at IS NULL`,
      [mapName],
    );

    const [scan] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.utility_drift_scans
         (map_name, from_revision, to_revision, lineups, requested_by_steam_id)
       VALUES ($1, $2, $3, $4::int, $5::bigint)
       RETURNING id::text AS id`,
      [
        mapName,
        UtilityDriftService.revision(input.from_revision),
        UtilityDriftService.revision(input.to_revision),
        Number(lineups),
        user.steam_id,
      ],
    );

    return { scan_id: scan.id, lineups: Number(lineups) };
  }

  public async runScan(scanId: string): Promise<void> {
    const [scan] = await this.postgres.query<
      Array<{
        id: string;
        map_name: string;
        from_revision: string | null;
        to_revision: string | null;
        status: string;
      }>
    >(
      `SELECT id::text AS id, map_name, from_revision, to_revision, status
         FROM public.utility_drift_scans
        WHERE id = $1::uuid`,
      [scanId],
    );

    if (!scan) {
      this.logger.warn(`[utility-drift] scan ${scanId} no longer exists`);
      return;
    }

    if (scan.status !== "Pending") {
      this.logger.warn(
        `[utility-drift] scan ${scanId} is ${scan.status}; refusing to run it twice`,
      );
      return;
    }

    await this.postgres.query(
      `UPDATE public.utility_drift_scans SET status = 'Running' WHERE id = $1::uuid`,
      [scan.id],
    );

    let after: string | null = null;
    let scanned = 0;

    for (;;) {
      const batch: Array<SeededLineup> = await this.batch(scan.map_name, after);

      if (batch.length === 0) {
        break;
      }

      after = batch.at(-1)!.id;

      const answer = await this.demoParser.drift({
        map: scan.map_name,
        ...(scan.from_revision ? { from: scan.from_revision } : {}),
        ...(scan.to_revision ? { to: scan.to_revision } : {}),
        lineups: batch.map((lineup) => UtilityDriftService.seed(lineup)),
      });

      if (!answer.data) {
        await this.fail(scan.id, answer.error);
        return;
      }

      await this.record(scan.id, batch, answer.data.results ?? []);
      scanned += batch.length;

      await this.postgres.query(
        `UPDATE public.utility_drift_scans SET scanned = $2::int WHERE id = $1::uuid`,
        [scan.id, scanned],
      );
    }

    await this.finish(scan.id);
  }

  private async batch(
    mapName: string,
    after: string | null,
  ): Promise<Array<SeededLineup>> {
    return await this.postgres.query<Array<SeededLineup>>(
      `SELECT id::text AS id, utility_type,
              initial_pos_x, initial_pos_y, initial_pos_z,
              initial_vel_x, initial_vel_y, initial_vel_z
         FROM public.utility_lineups
        WHERE map_name = $1
          AND archived_at IS NULL
          AND ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id ASC
        LIMIT ${UtilityDriftService.BATCH_SIZE}`,
      [mapName, after],
    );
  }

  // The parser answers by index, and ids round-trip, so results are matched on
  // the index the batch was sent in rather than on the id it echoed back.
  private async record(
    scanId: string,
    batch: Array<SeededLineup>,
    results: Array<ParsedDriftResult>,
  ): Promise<void> {
    for (const result of results) {
      const lineup = batch[result.index];

      if (!lineup) {
        continue;
      }

      await this.postgres.query(
        `INSERT INTO public.utility_drift_results
           (utility_drift_scan_id, utility_lineup_id, verdict, severity, reason,
            distance, distance_xy, distance_z)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (utility_drift_scan_id, utility_lineup_id) DO UPDATE
            SET verdict = EXCLUDED.verdict,
                severity = EXCLUDED.severity,
                reason = EXCLUDED.reason,
                distance = EXCLUDED.distance,
                distance_xy = EXCLUDED.distance_xy,
                distance_z = EXCLUDED.distance_z`,
        [
          scanId,
          lineup.id,
          result.verdict,
          result.severity ?? null,
          result.reason ?? null,
          result.distance ?? null,
          result.distance_xy ?? null,
          result.distance_z ?? null,
        ],
      );
    }
  }

  // Counted out of the rows rather than accumulated in memory, so a scan that
  // is resumed or re-recorded cannot double-count itself.
  private async finish(scanId: string): Promise<void> {
    const [scan] = await this.postgres.query<
      Array<{
        map_name: string;
        scanned: number;
        unchanged: number;
        moved: number;
        broken: number;
        unsimulatable: number;
        max_distance: number | null;
      }>
    >(
      `UPDATE public.utility_drift_scans s
          SET status = 'Finished',
              unchanged = t.unchanged,
              moved = t.moved,
              broken = t.broken,
              unsimulatable = t.unsimulatable,
              max_distance = t.max_distance
         FROM (
           SELECT count(*) FILTER (WHERE verdict = 'unchanged')::int AS unchanged,
                  count(*) FILTER (WHERE verdict = 'moved')::int AS moved,
                  count(*) FILTER (WHERE verdict = 'broken')::int AS broken,
                  count(*) FILTER (WHERE verdict = 'unsimulatable')::int AS unsimulatable,
                  max(distance) AS max_distance
             FROM public.utility_drift_results
            WHERE utility_drift_scan_id = $1::uuid
         ) AS t
        WHERE s.id = $1::uuid
       RETURNING s.map_name, s.scanned, s.unchanged, s.moved, s.broken,
                 s.unsimulatable, s.max_distance`,
      [scanId],
    );

    if (!scan) {
      return;
    }

    const moved = Number(scan.moved);
    const broken = Number(scan.broken);
    const distance =
      scan.max_distance === null
        ? ""
        : ` The furthest moved <b>${Math.round(Number(scan.max_distance))}</b> units.`;

    await this.announce(
      scanId,
      `Drift scan finished: ${scan.map_name}`,
      `Re-flew <b>${Number(scan.scanned)}</b> lineup(s) on <b>${NotificationsService.escapeHtml(scan.map_name)}</b>: ` +
        `<b>${moved}</b> moved, <b>${broken}</b> broken, ` +
        `<b>${Number(scan.unchanged)}</b> unchanged, ` +
        `<b>${Number(scan.unsimulatable)}</b> could not be simulated.${distance} ` +
        `${this.reviewLink()}`,
    );
  }

  private async fail(scanId: string, reason: string): Promise<void> {
    this.logger.warn(`[utility-drift] scan ${scanId} failed: ${reason}`);

    const [scan] = await this.postgres.query<Array<{ map_name: string }>>(
      `UPDATE public.utility_drift_scans
          SET status = 'Failed', failure_reason = $2
        WHERE id = $1::uuid
       RETURNING map_name`,
      [scanId, reason.slice(0, 500)],
    );

    // A scan that dies quietly is the same failure the feature exists to
    // prevent: nobody finds out the library was never checked against the
    // patch.
    await this.announce(
      scanId,
      `Drift scan failed: ${scan?.map_name ?? "unknown map"}`,
      `The scan stopped: ${NotificationsService.escapeHtml(reason.slice(0, 300))} ` +
        `${this.reviewLink()}`,
    );
  }

  // The admin drift review, which is where scans are listed with their verdict
  // counts. It takes no scan id today, so the link is the page itself.
  private reviewLink(): string {
    return `<a href="${this.appConfig.webDomain}/utility/drift">Review the scan</a>.`;
  }

  private async announce(
    scanId: string,
    title: string,
    message: string,
  ): Promise<void> {
    try {
      await this.notifications.send(
        "UtilityDriftScanFinished" as e_notification_types_enum,
        {
          title,
          message,
          role: "administrator" as e_player_roles_enum,
          entity_id: scanId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `[utility-drift] unable to announce scan ${scanId}: ${(error as Error)?.message}`,
      );
    }
  }

  // A lineup with no seed is sent anyway: the parser calls it unsimulatable for
  // the same reason we would, and one source of verdicts is worth the bytes.
  private static seed(lineup: SeededLineup): ParsedDriftLineup {
    const point = (x: number | null, y: number | null, z: number | null) =>
      x === null || y === null || z === null ? undefined : { x, y, z };

    return {
      id: lineup.id,
      utility_type: DemoParserService.parserUtilityType(lineup.utility_type),
      initial_position: point(
        lineup.initial_pos_x,
        lineup.initial_pos_y,
        lineup.initial_pos_z,
      ),
      initial_velocity: point(
        lineup.initial_vel_x,
        lineup.initial_vel_y,
        lineup.initial_vel_z,
      ),
    };
  }

  private static revision(value?: string | null): string | null {
    const revision = String(value ?? "").trim();

    return revision.length > 0 ? revision.slice(0, 200) : null;
  }
}
