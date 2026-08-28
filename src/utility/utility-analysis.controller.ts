import { Controller } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { UtilityQueues } from "./enums/UtilityQueues";
import { UtilityJobs } from "./enums/UtilityJobs";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { UtilityMetaService } from "./utility-meta.service";
import {
  UtilityAnalysisService,
  UtilitySightlinePairInput,
} from "./utility-analysis.service";
import { UtilityCalloutsService } from "./utility-callouts.service";
import { UtilityDriftService } from "./utility-drift.service";

@Controller("utility-analysis")
export class UtilityAnalysisController {
  constructor(
    private readonly analysis: UtilityAnalysisService,
    private readonly drift: UtilityDriftService,
    private readonly meta: UtilityMetaService,
    private readonly callouts: UtilityCalloutsService,
    @InjectQueue(UtilityQueues.UtilityDrift) private readonly driftQueue: Queue,
  ) {}

  // Re-mining is normally the hourly job's business, but a miner-version bump
  // changes what every stored throw MEANS, and waiting up to an hour per batch
  // of 25 demos to see corrected data is not a workable loop.
  @HasuraAction()
  public async remineUtilityMeta(data: { user: User }) {
    if (!data.user || !isRoleAbove(data.user.role, "administrator")) {
      throw new Error("only an administrator can re-mine demos");
    }

    const result = await this.meta.mine(UtilityMetaService.DEMOS_PER_RUN);

    return {
      demos: result.demos,
      throws: result.throws,
      // Each call takes one batch; the caller repeats until demos comes back 0.
      done: result.demos === 0,
    };
  }

  // The daily job is the normal path; this exists for the run right after a new
  // callouts tag is published, when waiting until 4am means every throw named
  // in between is named from the old map.
  @HasuraAction()
  public async syncMapCallouts(data: { user: User }) {
    if (!data.user || !isRoleAbove(data.user.role, "administrator")) {
      throw new Error("only an administrator can sync map callouts");
    }

    return await this.callouts.syncAll();
  }

  @HasuraAction()
  public async checkUtilitySightlines(data: {
    user: User;
    lineup_id: string;
    pairs: Array<UtilitySightlinePairInput>;
    threshold?: number;
  }) {
    return await this.analysis.sightlines(data.user ?? null, {
      lineup_id: data.lineup_id,
      pairs: data.pairs,
      threshold: data.threshold ?? null,
    });
  }

  @HasuraAction()
  public async checkUtilityOneWay(data: {
    user: User;
    lineup_id: string;
    pairs: Array<UtilitySightlinePairInput>;
  }) {
    return await this.analysis.oneWay(data.user ?? null, {
      lineup_id: data.lineup_id,
      pairs: data.pairs,
    });
  }

  @HasuraAction()
  public async analyseUtilityPlaybookCoverage(data: {
    user: User;
    playbook_id: string;
    pairs: Array<UtilitySightlinePairInput>;
  }) {
    return await this.analysis.playbookCoverage(data.user ?? null, {
      playbook_id: data.playbook_id,
      pairs: data.pairs,
    });
  }

  @HasuraAction()
  public async findUtilityLineupsBlocking(data: {
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
  // utility_drift_results rather than waited for here.
  @HasuraAction()
  public async startUtilityDriftScan(data: {
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

    await this.driftQueue.add(UtilityJobs.RunUtilityDriftScan, {
      scan_id: scan.scan_id,
    });

    return scan;
  }
}
