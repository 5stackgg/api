import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CheckForScheduledMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const fifteenMinutesAhead = new Date();
    fifteenMinutesAhead.setMinutes(fifteenMinutesAhead.getMinutes() + 15);
    const { update_matches } = await this.hasura.mutation({
      update_matches: {
        __args: {
          where: {
            _and: [
              {
                scheduled_at: {
                  _is_null: false,
                },
              },
              {
                scheduled_at: {
                  _lte: fifteenMinutesAhead,
                },
              },
              {
                status: {
                  _eq: "Scheduled",
                },
              },
              // Mirrors tournament_match_is_pre_start. A round-1 match
              // materialized before its tournament starts is parked, and
              // tbu_matches forces it straight back to Scheduled -- so without
              // this the UPDATE still reports an affected row and the job logs
              // "N matches started" for a no-op every single pass.
              {
                _not: {
                  tournament_brackets: {
                    stage: {
                      tournament: {
                        status: {
                          _in: ["RegistrationClosed", "CheckInReview"],
                        },
                        start: {
                          _gt: new Date(),
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
          _set: {
            status: "WaitingForCheckIn",
          },
        },
        affected_rows: true,
      },
    });

    if (update_matches.affected_rows > 0) {
      this.logger.log(`${update_matches.affected_rows} matches started`);
    }

    return update_matches.affected_rows;
  }
}
