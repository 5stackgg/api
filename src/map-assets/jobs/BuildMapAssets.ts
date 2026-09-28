import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MapAssetsQueues } from "../enums/MapAssetsQueues";
import { MapAssetsService } from "../map-assets.service";

type BuildMapAssetsData = {
  gameServerNodeId: string;
  buildId: string;
};

@UseQueue("MapAssets", MapAssetsQueues.BuildMapAssets)
export class BuildMapAssets extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly mapAssets: MapAssetsService,
  ) {
    super();
  }

  async process(job: Job<BuildMapAssetsData>): Promise<void> {
    const { gameServerNodeId } = job.data;
    const buildId = String(job.data.buildId);

    const outcome = await this.mapAssets.build(gameServerNodeId, buildId);

    if (outcome.status === "Failed") {
      this.logger.error(
        `[map-assets] build ${buildId} failed on ${gameServerNodeId}: ${outcome.error}`,
      );
      return;
    }

    this.logger.log(
      `[map-assets] published build ${buildId} (${Object.keys(outcome.maps ?? {}).length} maps)`,
    );
  }
}
