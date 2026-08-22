import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import { UtilitySolverStatus } from "./enums/UtilitySolverStatus";
import { UtilityLineupsService } from "./utility-lineups.service";
import { UtilitySolveOutput, UtilitySolverService } from "./utility-solver.service";

type DriftedLineup = {
  id: string;
  map_name: string;
  utility_type: string;
  name: string;
  origin_x: number;
  origin_y: number;
  origin_z: number;
  land_x: number;
  land_y: number;
  land_z: number;
  has_seed: boolean;
  visible: boolean;
  verdict: string | null;
  distance: number | null;
  utility_drift_scan_id: string | null;
};

// Re-solves a lineup a drift scan says the map moved.
//
// Nothing here simulates or throws anything itself: the whole job is to turn a
// verdict into the one question the solver already answers -- "find me a throw
// that lands here" -- with the drifted lineup's own landing point as the target
// and its own stance as the starting point. Every gate the solver applies (host,
// live session, calibration) applies unchanged, because a repair spends exactly
// the same two minutes of a practice server that a bare solve does.
@Injectable()
export class UtilityRepairService {
  // A solve is up to 300 grenades over two minutes. An hour is generous enough
  // to cover a queued solve and short enough that a forgotten ask cannot claim a
  // lineup recorded in a different session hours later.
  private static readonly WINDOW_MINUTES = 60;

  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly solver: UtilitySolverService,
    private readonly lineups: UtilityLineupsService,
  ) {}

  public async repair(
    user: User,
    input: { utility_lineup_id: string; session_id: string },
  ): Promise<UtilitySolveOutput> {
    if (!(await this.lineups.isLibraryEnabled())) {
      throw Error("the utility library is disabled");
    }

    const lineupId = String(input.utility_lineup_id ?? "");

    if (!UtilityRepairService.UUID.test(lineupId)) {
      throw Error("lineup not found");
    }

    const lineup = await this.drifted(user, lineupId);

    if (!lineup || !lineup.visible) {
      throw Error("lineup not found");
    }

    const refusal = UtilityRepairService.refuse(lineup);

    if (refusal) {
      return refusal;
    }

    const session = await this.session(input.session_id);

    // Checked here rather than left to the solver, which has no opinion about
    // which map a target belongs to: solving de_mirage coordinates on de_nuke
    // would spend the server's two minutes chasing a point inside a wall.
    // Only asked of the host, because a caller who is not the host is about to
    // be refused anyway and does not get to learn what map the session is on.
    if (
      session.host_steam_id === user.steam_id &&
      session.map_name !== lineup.map_name
    ) {
      return {
        accepted: false,
        status: UtilitySolverStatus.WrongMap,
        message: `this lineup is on ${lineup.map_name}; the session is on ${session.map_name}`,
      };
    }

    const repairId = randomUUID();

    const answer = await this.solver.solve(user, {
      session_id: input.session_id,
      target_x: Number(lineup.land_x),
      target_y: Number(lineup.land_y),
      target_z: Number(lineup.land_z),
      from_x: Number(lineup.origin_x),
      from_y: Number(lineup.origin_y),
      from_z: Number(lineup.origin_z),
      utility_type: lineup.utility_type,
      // The lineup the solver finds arrives later through POST /utility/ingest,
      // and the only field that survives that round trip is the name. So the
      // name is the correlation id. If a plugin build ever stops echoing it the
      // repair simply expires unclaimed -- which is today's behaviour, a new
      // lineup with no link, rather than a stranger's throw claimed as a repair.
      name: UtilityLineupsService.repairName(repairId),
      // The bar a throw has to clear to count as the same lineup in practice is
      // the bar a repair has to clear to be the same lineup at all.
      tolerance: await this.lineups.successRadius(),
    });

    // Recorded only once the server has agreed to look. A refusal that leaves a
    // Requested row behind would let the next lineup this player saves in this
    // session be claimed as the repair.
    if (answer.accepted) {
      await this.record(repairId, user.steam_id, input.session_id, lineup);
    }

    return answer;
  }

  private static refuse(lineup: DriftedLineup): UtilitySolveOutput | null {
    if (!lineup.verdict) {
      return {
        accepted: false,
        status: UtilitySolverStatus.NotScanned,
        message:
          "no drift scan has judged this lineup, so there is nothing to repair it against",
      };
    }

    if (lineup.verdict !== "moved") {
      return {
        accepted: false,
        status: UtilitySolverStatus.NotMoved,
        message: UtilityRepairService.verdictReason(lineup.verdict),
      };
    }

    // A 'moved' verdict implies the scan could re-fly it, so this is a lineup
    // whose seed was cleared after the scan rather than an ordinary refusal.
    if (!lineup.has_seed) {
      return {
        accepted: false,
        status: UtilitySolverStatus.Seedless,
        message:
          "this lineup has no physics seed, so there is no throw to re-solve",
      };
    }

    return null;
  }

  private static verdictReason(verdict: string): string {
    if (verdict === "broken") {
      return "the scan could not land this throw anywhere on the new map, so there is no point to re-solve onto";
    }

    if (verdict === "unsimulatable") {
      return "the scan could not re-fly this lineup at all, which says nothing about whether the map moved it";
    }

    return "the scan found this lineup unchanged, so there is nothing to repair";
  }

  private async drifted(
    user: User,
    lineupId: string,
  ): Promise<DriftedLineup | null> {
    const [row] = await this.postgres.query<Array<DriftedLineup>>(
      `SELECT l.id::text AS id, l.map_name, l.utility_type, l.name,
              l.origin_x, l.origin_y, l.origin_z,
              l.land_x, l.land_y, l.land_z,
              (l.initial_pos_x IS NOT NULL AND l.initial_pos_y IS NOT NULL
               AND l.initial_pos_z IS NOT NULL AND l.initial_vel_x IS NOT NULL
               AND l.initial_vel_y IS NOT NULL AND l.initial_vel_z IS NOT NULL)
                AS has_seed,
              public.can_view_utility_lineup(l, $2::json) AS visible,
              latest.verdict, latest.distance,
              latest.utility_drift_scan_id::text AS utility_drift_scan_id
         FROM public.utility_lineups l
         LEFT JOIN LATERAL (
           SELECT dr.verdict, dr.distance, dr.utility_drift_scan_id
             FROM public.utility_drift_results dr
             INNER JOIN public.utility_drift_scans s
                     ON s.id = dr.utility_drift_scan_id
            WHERE dr.utility_lineup_id = l.id
            ORDER BY s.created_at DESC, dr.created_at DESC
            LIMIT 1
         ) AS latest ON true
        WHERE l.id = $1::uuid`,
      [
        lineupId,
        JSON.stringify({
          "x-hasura-role": user.role,
          "x-hasura-user-id": user.steam_id,
        }),
      ],
    );

    return row ?? null;
  }

  private async session(
    sessionId: string,
  ): Promise<{ host_steam_id: string; map_name: string }> {
    if (!UtilityRepairService.UUID.test(String(sessionId ?? ""))) {
      throw Error("practice session not found");
    }

    const [row] = await this.postgres.query<
      Array<{ host_steam_id: string; map_name: string }>
    >(
      `SELECT host_steam_id::text AS host_steam_id, map_name
         FROM public.utility_practice_sessions
        WHERE id = $1::uuid`,
      [sessionId],
    );

    if (!row) {
      throw Error("practice session not found");
    }

    return row;
  }

  private async record(
    repairId: string,
    steamId: string,
    sessionId: string,
    lineup: DriftedLineup,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_lineup_repairs
          SET status = 'Expired'
        WHERE status = 'Requested' AND expires_at <= now()`,
    );

    await this.postgres.query(
      `INSERT INTO public.utility_lineup_repairs
         (id, utility_lineup_id, utility_drift_scan_id, utility_practice_session_id,
          requested_by_steam_id, drift_distance, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6,
               now() + interval '${UtilityRepairService.WINDOW_MINUTES} minutes')
       ON CONFLICT (utility_lineup_id, requested_by_steam_id)
            WHERE status = 'Requested'
       DO UPDATE SET id = EXCLUDED.id,
                     utility_drift_scan_id = EXCLUDED.utility_drift_scan_id,
                     utility_practice_session_id = EXCLUDED.utility_practice_session_id,
                     drift_distance = EXCLUDED.drift_distance,
                     expires_at = EXCLUDED.expires_at,
                     created_at = now()`,
      [
        repairId,
        lineup.id,
        lineup.utility_drift_scan_id,
        sessionId,
        steamId,
        lineup.distance,
      ],
    );

    this.logger.log(
      `[utility-repair] ${steamId} is re-solving ${lineup.id} as ${repairId}`,
    );
  }
}
