import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { NadePracticeService } from "./nade-practice.service";
import { NadeLineupsService } from "./nade-lineups.service";
import { NadeRepairService } from "./nade-repair.service";
import { NadeSolverService } from "./nade-solver.service";

@Controller("nade-practice")
export class NadePracticeController {
  constructor(
    private readonly practice: NadePracticeService,
    private readonly lineups: NadeLineupsService,
    private readonly solver: NadeSolverService,
    private readonly repairs: NadeRepairService,
  ) {}

  @HasuraAction()
  public async startNadePractice(data: {
    user: User;
    map_name: string;
    region?: string;
    collection_id?: string;
    team_id?: string;
    is_open?: boolean;
  }) {
    const { user, map_name, region, collection_id, team_id, is_open } = data;

    const session = await this.practice.start(user, {
      map_name,
      region,
      collection_id,
      team_id,
      is_open,
    });

    return {
      id: session.id,
      match_id: session.match_id,
      status: session.status,
      invite_code: session.invite_code,
    };
  }

  @HasuraAction()
  public async joinNadePractice(data: {
    user: User;
    session_id?: string;
    invite_code?: string;
  }) {
    const { user, session_id, invite_code } = data;

    const joined = await this.practice.join(user, { session_id, invite_code });

    return {
      id: joined.session_id,
      match_id: joined.match_id,
    };
  }

  @HasuraAction()
  public async leaveNadePractice(data: { user: User; session_id: string }) {
    return await this.practice.leave(data.user, {
      session_id: data.session_id,
    });
  }

  @HasuraAction()
  public async stopNadePractice(data: { user: User; session_id: string }) {
    return await this.practice.stop(data.user, {
      session_id: data.session_id,
    });
  }

  @HasuraAction()
  public async inviteToNadePractice(data: {
    user: User;
    session_id: string;
    steam_ids: Array<string>;
  }) {
    return await this.practice.invite(data.user, {
      session_id: data.session_id,
      steam_ids: data.steam_ids,
    });
  }

  @HasuraAction()
  public async nadeSolverCalibration(data: { user: User; session_id: string }) {
    return await this.solver.calibration(data.user, data.session_id);
  }

  // Accepts or refuses; it never waits. A solve is up to 300 grenades over two
  // minutes, and the lineup it finds arrives through POST /nades/ingest, which
  // the plugin already drives.
  @HasuraAction()
  public async solveNadeLineup(data: {
    user: User;
    session_id: string;
    target_x: number;
    target_y: number;
    target_z: number;
    from_x?: number;
    from_y?: number;
    from_z?: number;
    utility_type?: string;
    name?: string;
    tolerance?: number;
  }) {
    const { user, ...input } = data;

    return await this.solver.solve(user, input);
  }

  // Same shape and the same wait as solveNadeLineup, because it is one: a
  // repair is a solve aimed at a drifted lineup's own landing point.
  @HasuraAction()
  public async repairNadeLineup(data: {
    user: User;
    nade_lineup_id: string;
    session_id: string;
  }) {
    return await this.repairs.repair(data.user, {
      nade_lineup_id: data.nade_lineup_id,
      session_id: data.session_id,
    });
  }

  @HasuraAction()
  public async saveNadeLineupFromPractice(data: {
    user: User;
    session_id: string;
    nade_lineup_id: string;
    name: string;
    description?: string;
    visibility?: string;
    team_id?: string;
    tags?: Array<string>;
    collection_id?: string;
  }) {
    const { user, session_id, nade_lineup_id } = data;

    const session = await this.practice.session(session_id);

    if (!session) {
      throw Error("practice session not found");
    }

    if (!session.match_id) {
      throw Error("that practice session never had a server");
    }

    // The geometry is never taken from the caller. Saving only ever relabels a
    // lineup the server itself recorded, so a client cannot invent a lineup and
    // publish it as an exact one.
    return await this.lineups.saveFromPractice({
      steamId: user.steam_id,
      matchId: session.match_id,
      lineupId: nade_lineup_id,
      name: data.name,
      description: data.description,
      visibility: data.visibility,
      teamId: data.team_id ?? null,
      tags: data.tags,
      collectionId: data.collection_id ?? null,
    });
  }
}
