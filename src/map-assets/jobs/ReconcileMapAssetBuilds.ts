import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MapAssetsQueues } from "../enums/MapAssetsQueues";
import { MapAssetsService } from "../map-assets.service";

@UseQueue("MapAssets", MapAssetsQueues.ReconcileMapAssetBuilds)
export class ReconcileMapAssetBuilds extends WorkerHost {
  constructor(private readonly mapAssets: MapAssetsService) {
    super();
  }

  async process(): Promise<void> {
    await this.mapAssets.reconcileStrandedBuilds();
  }
}
