import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { GameServerNodeService } from "../game-server-node.service";

@UseQueue("GameServerNode", GameServerQueues.GameUpdate)
export class ReconcileGamedataValidations extends WorkerHost {
  constructor(private readonly gameServerNodeService: GameServerNodeService) {
    super();
  }

  async process(): Promise<void> {
    await this.gameServerNodeService.reconcileStrandedGamedataValidations();
  }
}
