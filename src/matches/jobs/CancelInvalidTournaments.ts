import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelInvalidTournaments extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  async process(job: Job): Promise<number> {
    const { update_tournaments } = await this.hasura.mutation({
      update_tournaments: {
        __args: {
          where: {
            _and: [
              {
                status: {
                  _eq: "RegistrationOpen"
                },
              },
              {
                has_min_teams: {
                  _eq: false,
                },
              },
              {
                start: {
                  _gte: new Date(),
                },
              },
            ],
          },
        },
        affected_rows: true,
      },
    });


    if (update_tournaments.affected_rows > 0) {
      this.logger.log(`${update_tournaments.affected_rows} matches started`);
    }

    return update_tournaments.affected_rows;

  }
}
