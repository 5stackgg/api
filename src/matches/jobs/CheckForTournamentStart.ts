import { Processor, WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";

@Processor(MatchQueues.MatchServers)
export class CheckForTournamentStart extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  async process(): Promise<number> {
    const fifteenMinutesAgo = new Date();
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    const { update_tournaments } = await this.hasura.mutation({
      update_tournaments: {
        __args: {
          where: {
            start: {
              _gte: fifteenMinutesAgo,
            },
          },
          _set: {
            status: "Live",
          },
        },
        affected_rows: true,
      },
    });
    if (update_tournaments.affected_rows > 0) {
      this.logger.log(
        `${update_tournaments.affected_rows} tournaments started`,
      );
    }

    return update_tournaments.affected_rows;
  }
}
