import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { GameServerNodeService } from "../game-server-node.service";
import { MapAssetsService } from "src/map-assets/map-assets.service";

// Only an api restart strands a CS2 build run, so this follows each boot
// rather than running on a schedule.
@UseQueue("GameServerNode", GameServerQueues.GameUpdate)
export class ReconcileCs2BuildRuns extends WorkerHost {
  public static readonly JOB_ID = "reconcile-cs2-build-runs";

  // Past the stall checks, which hand BullMQ back whatever it still can.
  public static readonly DELAY_MS = 5 * 60 * 1000;

  constructor(
    private readonly gameServerNodeService: GameServerNodeService,
    private readonly mapAssets: MapAssetsService,
  ) {
    super();
  }

  async process(): Promise<void> {
    await this.mapAssets.reconcileStrandedBuilds();
    await this.gameServerNodeService.reconcileStrandedGamedataValidations();
  }
}
