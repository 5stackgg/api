import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { PostgresService } from "../postgres/postgres.service";
import { RconService } from "../rcon/rcon.service";
import { User } from "../auth/types/User";
import { NadeSolverStatus } from "./enums/NadeSolverStatus";

export type NadeCalibrationOutput = {
  status: string;
  ready: boolean;
  detail: string | null;
};

export type NadeSolveOutput = {
  accepted: boolean;
  status: string;
  message: string | null;
};

export type SolveNadeLineupInput = {
  session_id: string;
  target_x: number;
  target_y: number;
  target_z: number;
  from_x?: number | null;
  from_y?: number | null;
  from_z?: number | null;
  utility_type?: string | null;
  name?: string | null;
  tolerance?: number | null;
};

type SolverServer = {
  session_id: string;
  host_steam_id: string;
  status: string;
  map_name: string;
  server_id: string | null;
  plugin_runtime: string | null;
};

// Drives the practice plugin's oracle solver over RCON.
//
// The solve itself is long (up to 300 grenades / 120s) and produces a lineup by
// posting it to POST /nades/ingest itself, so nothing here ever waits for a
// result: the action's whole job is to prove the caller may spend a practice
// server's next two minutes, and then say so.
@Injectable()
export class NadeSolverService {
  // The plugin only prints "ready" when a report can solve; every other
  // spelling is the enum name from eCalibrationStatus.
  private static readonly STATUSES: ReadonlyArray<string> = [
    NadeSolverStatus.Ready,
    NadeSolverStatus.NoSample,
    NadeSolverStatus.LaunchModelMismatch,
    NadeSolverStatus.SeedReplayMismatch,
    NadeSolverStatus.SeedReplayTimedOut,
    NadeSolverStatus.Unsupported,
    NadeSolverStatus.Unknown,
  ];

  // "<map>: <status>", which is the one thing every calibration reply prints
  // before its prose.
  private static readonly VERDICT = /(?:^|\s)[A-Za-z0-9_]+:\s*([A-Za-z]+)/;

  private static readonly UNSUPPORTED_RUNTIME = "counterstrikesharp";

  // Only a server that has actually booted can throw a grenade. 'Starting' is a
  // session waiting on a pod, which is a different answer from a refusal.
  private static readonly SOLVABLE_STATUS = "Ready";

  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    @Inject(forwardRef(() => RconService))
    private readonly rcon: RconService,
  ) {}

  // A solve burns up to 300 grenades and two minutes of a practice pod, so the
  // real constraint is concurrency rather than a per-minute count: a second
  // solve on the same pod fights the first for grenades and both measure noise.
  // The lock's TTL is the solve's own ceiling plus slack, so it clears itself
  // when a solve dies without reporting.
  public static readonly SOLVE_LOCK_SECONDS = 150;
  public static readonly SOLVES_PER_HOUR = 6;

  private async setting(name: string): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      "SELECT value FROM public.settings WHERE name = $1 LIMIT 1",
      [name],
    );
    return row?.value ?? null;
  }

  private async claimSolveBudget(
    steamId: string,
  ): Promise<NadeSolveOutput | null> {
    const perHour = Number(
      await this.setting(SystemSettingName.NadeSolvesPerHour),
    );
    const cap =
      Number.isFinite(perHour) && perHour > 0
        ? perHour
        : NadeSolverService.SOLVES_PER_HOUR;

    // The hour is part of the key, not a refreshed TTL: re-setting the TTL on
    // every attempt walks the window ahead of somebody who never stops and
    // locks them out for good.
    const hour = Math.floor(Date.now() / 3600000);
    const countKey = `nade-solve-count:${steamId}:${hour}`;
    const used = Number(await this.cache.get(countKey, 0));

    if (used >= cap) {
      const minutes = Math.max(
        1,
        60 - Math.floor((Date.now() % 3600000) / 60000),
      );

      return {
        accepted: false,
        status: NadeSolverStatus.Busy,
        message: `you have used all ${cap} solves for this hour, try again in ${minutes} minute${minutes === 1 ? "" : "s"}`,
      };
    }

    if (
      !(await this.cache.acquireLock(
        `nade-solve:${steamId}`,
        NadeSolverService.SOLVE_LOCK_SECONDS,
      ))
    ) {
      return {
        accepted: false,
        status: NadeSolverStatus.Busy,
        message:
          "you already have a solve running, wait for it to finish or cancel it",
      };
    }

    await this.cache.put(countKey, used + 1, 7200);

    return null;
  }

  public async calibration(
    user: User,
    sessionId: string,
  ): Promise<NadeCalibrationOutput> {
    const session = await this.solverSession(user, sessionId);

    if ("refusal" in session) {
      return {
        status: session.refusal.status,
        ready: false,
        detail: session.refusal.message,
      };
    }

    return await this.calibrate(session.server);
  }

  public async solve(
    user: User,
    input: SolveNadeLineupInput,
  ): Promise<NadeSolveOutput> {
    const session = await this.solverSession(user, input.session_id);

    if ("refusal" in session) {
      return {
        accepted: false,
        status: session.refusal.status,
        message: session.refusal.message,
      };
    }

    const target = NadeSolverService.point(
      input.target_x,
      input.target_y,
      input.target_z,
      "target",
    );
    const from =
      input.from_x === undefined ||
      input.from_x === null ||
      input.from_y === undefined ||
      input.from_y === null ||
      input.from_z === undefined ||
      input.from_z === null
        ? null
        : NadeSolverService.point(
            input.from_x,
            input.from_y,
            input.from_z,
            "from",
          );

    const budget = await this.claimSolveBudget(user.steam_id);

    if (budget) {
      return budget;
    }

    const calibration = await this.calibrate(session.server);

    if (!calibration.ready) {
      return {
        accepted: false,
        status: calibration.status,
        message: calibration.detail,
      };
    }

    const args = [
      `target=${NadeSolverService.vector(target)}`,
      ...(from ? [`from=${NadeSolverService.vector(from)}`] : []),
      ...(input.utility_type
        ? [`utility=${NadeSolverService.token(input.utility_type)}`]
        : []),
      `steam=${user.steam_id}`,
      ...(input.name ? [`name=${NadeSolverService.token(input.name)}`] : []),
      ...(input.tolerance
        ? [
            `tolerance=${NadeSolverService.number(input.tolerance, "tolerance")}`,
          ]
        : []),
    ];

    const reply = await this.send(
      session.server.server_id,
      `nade_solver_solve ${args.join(" ")}`,
    );

    if (reply === null) {
      return {
        accepted: false,
        status: NadeSolverStatus.Unreachable,
        message: "unable to reach the practice server over rcon",
      };
    }

    this.logger.log(
      `[nade-solver] ${session.server.session_id} solving for ${user.steam_id}: ${NadeSolverService.clean(reply) || "no reply"}`,
    );

    // The plugin answers the RCON as soon as the search is queued and posts the
    // winning lineup to /nades/ingest itself minutes later, so "accepted" is
    // the only thing that can honestly be said here.
    return {
      accepted: true,
      status: NadeSolverStatus.Solving,
      message: NadeSolverService.clean(reply) || null,
    };
  }

  private async calibrate(
    server: SolverServer,
  ): Promise<NadeCalibrationOutput> {
    // Asked before a single grenade is spent, because the answer is a property
    // of the runtime rather than of this throw: CounterStrikeSharp has no way to
    // emit a projectile, so its build of the plugin answers Unsupported.
    if (
      (server.plugin_runtime ?? "").toLowerCase() ===
      NadeSolverService.UNSUPPORTED_RUNTIME
    ) {
      return {
        status: NadeSolverStatus.Unsupported,
        ready: false,
        detail:
          "the solver needs a grenade emit API, which CounterStrikeSharp does not expose; run the SwiftlyS2 build of this plugin to use it",
      };
    }

    const reply = await this.send(server.server_id, "nade_solver_calibrate");

    if (reply === null) {
      return {
        status: NadeSolverStatus.Unreachable,
        ready: false,
        // "cannot solve" and "could not tell" lead somewhere different, so they
        // must not read the same. A server that never reported a runtime AND
        // will not answer rcon is the second one: saying it cannot solve would
        // send somebody redeploying a plugin that may be perfectly fine.
        detail: server.plugin_runtime
          ? "unable to reach the practice server over rcon"
          : "this server has not reported which plugin runtime it is running and did not answer rcon, so whether it can solve is unknown",
      };
    }

    return NadeSolverService.readCalibration(reply);
  }

  // The plugin prints "<map>: <status>[ (cached)] <message>" with chat colour
  // bytes in it. A reply that names no status is not a failure -- an
  // uncalibrated map answers "calibrating the solver on de_mirage..." and the
  // verdict arrives on a later call.
  public static readCalibration(reply: string): NadeCalibrationOutput {
    const text = NadeSolverService.clean(reply);
    const spoken = text.match(NadeSolverService.VERDICT)?.at(1) ?? "";

    const status = NadeSolverService.STATUSES.find(
      (candidate) => candidate.toLowerCase() === spoken.toLowerCase(),
    );

    if (status) {
      return {
        status,
        ready: status === NadeSolverStatus.Ready,
        detail: text || null,
      };
    }

    if (/is already running/i.test(text)) {
      return {
        status: NadeSolverStatus.Busy,
        ready: false,
        detail: text,
      };
    }

    return {
      status: NadeSolverStatus.Unknown,
      ready: false,
      detail: text || "the practice server did not answer with a verdict",
    };
  }

  private async solverSession(
    user: User,
    sessionId: string,
  ): Promise<
    { server: SolverServer } | { refusal: { status: string; message: string } }
  > {
    if (!NadeSolverService.UUID.test(String(sessionId ?? ""))) {
      throw Error("practice session not found");
    }

    const [row] = await this.postgres.query<Array<SolverServer>>(
      `SELECT s.id::text AS session_id,
              s.host_steam_id::text AS host_steam_id,
              s.status,
              s.map_name,
              srv.id::text AS server_id,
              srv.plugin_runtime
         FROM public.nade_practice_sessions s
         LEFT JOIN public.matches m ON m.id = s.match_id
         LEFT JOIN public.servers srv ON srv.id = m.server_id
        WHERE s.id = $1::uuid`,
      [sessionId],
    );

    if (!row) {
      throw Error("practice session not found");
    }

    if (row.host_steam_id !== user.steam_id) {
      return {
        refusal: {
          status: NadeSolverStatus.NotHost,
          message: "only the session host can drive the solver",
        },
      };
    }

    if (row.status !== NadeSolverService.SOLVABLE_STATUS) {
      return {
        refusal: {
          status: NadeSolverStatus.NotLive,
          message: `this practice session is ${row.status}, not ${NadeSolverService.SOLVABLE_STATUS}`,
        },
      };
    }

    if (!row.server_id) {
      return {
        refusal: {
          status: NadeSolverStatus.NoServer,
          message: "this practice session has no server",
        },
      };
    }

    return { server: row };
  }

  private async send(
    serverId: string | null,
    command: string,
  ): Promise<string | null> {
    if (!serverId) {
      return null;
    }

    try {
      const connection = await this.rcon.connect(serverId);

      if (!connection) {
        return null;
      }

      return await connection.send(command);
    } catch (error) {
      this.logger.warn(
        `[nade-solver] ${serverId} rcon failed: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  // Chat colour codes are single control bytes the plugin prepends to every
  // word; leaving them in makes every regex below miss.
  private static clean(reply: string): string {
    return String(reply ?? "")
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private static vector(point: { x: number; y: number; z: number }): string {
    return `${point.x.toFixed(2)},${point.y.toFixed(2)},${point.z.toFixed(2)}`;
  }

  private static point(
    x: number,
    y: number,
    z: number,
    label: string,
  ): { x: number; y: number; z: number } {
    for (const value of [x, y, z]) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw Error(`${label} must be finite coordinates`);
      }
    }

    return { x, y, z };
  }

  // The plugin splits its arguments on whitespace, so a value with a space in
  // it silently becomes a second, unknown argument and the whole solve is
  // refused. Everything the caller supplies is collapsed to one token.
  private static token(value: string): string {
    const token = String(value ?? "")
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);

    if (!token) {
      throw Error("that value has no characters the plugin can accept");
    }

    return token;
  }

  private static number(value: number, label: string): string {
    if (!Number.isFinite(value) || value <= 0) {
      throw Error(`${label} must be a positive number`);
    }

    return value.toFixed(2);
  }
}
