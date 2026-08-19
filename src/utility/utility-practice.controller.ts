import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { UtilityPracticeService } from "./utility-practice.service";
import { UtilityLineupsService } from "./utility-lineups.service";
import { UtilityRepairService } from "./utility-repair.service";
import { UtilitySolverService } from "./utility-solver.service";

@Controller("utility-practice")
export class UtilityPracticeController {
  constructor(
    private readonly practice: UtilityPracticeService,
    private readonly lineups: UtilityLineupsService,
    private readonly solver: UtilitySolverService,
    private readonly repairs: UtilityRepairService,
  ) {}

  @HasuraAction()
  public async utilityPracticeServers(data: { user: User }) {
    return { servers: await this.practice.practiceServers(data.user) };
  }

  @HasuraAction()
  public async startUtilityPractice(data: {
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
  public async joinUtilityPractice(data: {
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
  public async leaveUtilityPractice(data: { user: User; session_id: string }) {
    return await this.practice.leave(data.user, {
      session_id: data.session_id,
    });
  }

  @HasuraAction()
  public async stopUtilityPractice(data: { user: User; session_id: string }) {
    return await this.practice.stop(data.user, {
      session_id: data.session_id,
    });
  }

  @HasuraAction()
  public async inviteToUtilityPractice(data: {
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
  public async utilitySolverCalibration(data: { user: User; session_id: string }) {
    return await this.solver.calibration(data.user, data.session_id);
  }

  // Accepts or refuses; it never waits. A solve is up to 300 grenades over two
  // minutes, and the lineup it finds arrives through POST /utility/ingest, which
  // the plugin already drives.
  @HasuraAction()
  public async solveUtilityLineup(data: {
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

  // Same shape and the same wait as solveUtilityLineup, because it is one: a
  // repair is a solve aimed at a drifted lineup's own landing point.
  @HasuraAction()
  public async repairUtilityLineup(data: {
    user: User;
    utility_lineup_id: string;
    session_id: string;
  }) {
    return await this.repairs.repair(data.user, {
      utility_lineup_id: data.utility_lineup_id,
      session_id: data.session_id,
    });
  }

  @HasuraAction()
  public async saveUtilityLineupFromPractice(data: {
    user: User;
    session_id: string;
    utility_lineup_id: string;
    name: string;
    description?: string;
    visibility?: string;
    team_id?: string;
    tags?: Array<string>;
    collection_id?: string;
  }) {
    const { user, session_id, utility_lineup_id } = data;

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
      lineupId: utility_lineup_id,
      name: data.name,
      description: data.description,
      visibility: data.visibility,
      teamId: data.team_id ?? null,
      tags: data.tags,
      collectionId: data.collection_id ?? null,
    });
  }
}
