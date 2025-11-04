import { WorkerHost } from "@nestjs/bullmq";
import { TypesenseQueues } from "../enums/TypesenseQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { TypeSenseService } from "../type-sense.service";
import { PostgresService } from "src/postgres/postgres.service";
import { Inject, forwardRef } from "@nestjs/common";

@UseQueue("TypeSense", TypesenseQueues.TypeSense)
export class RefreshAllPlayersJob extends WorkerHost {
  constructor(
    private readonly postgres: PostgresService,
    @Inject(forwardRef(() => TypeSenseService))
    private readonly typeSense: TypeSenseService,
  ) {
    super();
  }
  async process(): Promise<void> {
    const cursor = this.postgres.cursor<{ steam_id: bigint }>(
      "SELECT steam_id FROM players",
    );

    for await (const batch of cursor) {
      for (const player of batch) {
        await this.typeSense.updatePlayer(player.steam_id.toString());
      }
    }
  }
}
