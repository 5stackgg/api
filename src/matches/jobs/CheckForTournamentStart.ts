import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.MatchServers)
export class CheckForTournamentStart extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  async process(job: Job): Promise<number> {
    const fifteenMinutesAhead = new Date();
    fifteenMinutesAhead.setMinutes(fifteenMinutesAhead.getMinutes() + 15);

    try {
      const { update_tournaments } = await this.hasura.mutation({
        update_tournaments: {
          __args: {
            where: {
              _and: [
                {
                  start: {
                    _lte: fifteenMinutesAhead,
                  },
                },
                {
                  status: {
                    _in: ["RegistrationOpen", "RegistrationClosed"],
                  },
                },
              ],
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
    } catch (error) {
      console.info(`cannto update`, JSON.stringify(error));
    }
  }
}
