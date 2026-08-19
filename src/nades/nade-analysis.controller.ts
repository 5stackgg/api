import { Controller } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { NadeQueues } from "./enums/NadeQueues";
import { NadeJobs } from "./enums/NadeJobs";
import {
  NadeAnalysisService,
  NadeSightlinePairInput,
} from "./nade-analysis.service";
import { NadeDriftService } from "./nade-drift.service";

@Controller("nade-analysis")
export class NadeAnalysisController {
  constructor(
    private readonly analysis: NadeAnalysisService,
    private readonly drift: NadeDriftService,
    @InjectQueue(NadeQueues.NadeDrift) private readonly driftQueue: Queue,
  ) {}

  @HasuraAction()
  public async checkNadeSightlines(data: {
    user: User;
    lineup_id: string;
    pairs: Array<NadeSightlinePairInput>;
    threshold?: number;
  }) {
    return await this.analysis.sightlines(data.user ?? null, {
      lineup_id: data.lineup_id,
      pairs: data.pairs,
      threshold: data.threshold ?? null,
    });
  }

  @HasuraAction()
  public async checkNadeOneWay(data: {
    user: User;
    lineup_id: string;
    pairs: Array<NadeSightlinePairInput>;
  }) {
    return await this.analysis.oneWay(data.user ?? null, {
      lineup_id: data.lineup_id,
      pairs: data.pairs,
    });
  }

  @HasuraAction()
  public async analyseNadePlaybookCoverage(data: {
    user: User;
    playbook_id: string;
    pairs: Array<NadeSightlinePairInput>;
  }) {
    return await this.analysis.playbookCoverage(data.user ?? null, {
      playbook_id: data.playbook_id,
      pairs: data.pairs,
    });
  }

  @HasuraAction()
  public async findNadeLineupsBlocking(data: {
    user: User;
    map_name: string;
    from_x: number;
    from_y: number;
    from_z: number;
    to_x: number;
    to_y: number;
    to_z: number;
    side?: string;
    limit?: number;
  }) {
    const { user, ...input } = data;

    return await this.analysis.findBlocking(user ?? null, input);
  }

  // Returns as soon as the scan row exists. Re-flying a map's whole library is
  // minutes of simulation against two meshes, and the results are read back off
  // nade_drift_results rather than waited for here.
  @HasuraAction()
  public async startNadeDriftScan(data: {
    user: User;
    map_name: string;
    from_revision?: string;
    to_revision?: string;
  }) {
    const scan = await this.drift.startScan(data.user, {
      map_name: data.map_name,
      from_revision: data.from_revision ?? null,
      to_revision: data.to_revision ?? null,
    });

    await this.driftQueue.add(NadeJobs.RunNadeDriftScan, {
      scan_id: scan.scan_id,
    });

    return scan;
  }
}
