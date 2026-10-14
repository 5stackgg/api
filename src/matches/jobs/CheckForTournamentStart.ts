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
  async process(): Promise<number> {
    const now = new Date();
    const fifteenMinutesAhead = new Date(now);
    fifteenMinutesAhead.setMinutes(fifteenMinutesAhead.getMinutes() + 15);

    let started = 0;

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
                    _eq: "RegistrationClosed",
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

      started += update_tournaments.affected_rows;
    } catch (error) {
      this.logger.error(`cannot update tournaments`, JSON.stringify(error));
    }

    started += await this.startOpenTournaments(now);

    if (started > 0) {
      this.logger.log(`${started} tournaments started`);
    }

    return started;
  }

  // Without check-in nothing closes registration, so a tournament left open
  // starts at its start time, the moment registration was promised to close.
  // Only one whose start has just passed: one left open longer than that is
  // its organizer's to start, and short of teams is CancelInvalidTournaments'
  // to cancel. One at a time: going Live from open drafts, seeds and draws the
  // bracket, and one tournament that cannot must not hold back the rest.
  private async startOpenTournaments(now: Date): Promise<number> {
    const fifteenMinutesAgo = new Date(now);
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    let due: Array<{ id: string }>;
    try {
      ({ tournaments: due } = await this.hasura.query({
        tournaments: {
          __args: {
            where: {
              status: { _eq: "RegistrationOpen" },
              check_in_required: { _eq: false },
              start: { _lte: now, _gt: fifteenMinutesAgo },
              has_min_teams: { _eq: true },
            },
          },
          id: true,
        },
      }));
    } catch (error) {
      this.logger.error(`cannot find open tournaments`, JSON.stringify(error));
      return 0;
    }

    let started = 0;
    for (const { id } of due) {
      try {
        const { update_tournaments } = await this.hasura.mutation({
          update_tournaments: {
            __args: {
              where: {
                id: { _eq: id },
                status: { _eq: "RegistrationOpen" },
                check_in_required: { _eq: false },
              },
              _set: {
                status: "Live",
              },
            },
            affected_rows: true,
          },
        });
        started += update_tournaments.affected_rows;
      } catch (error) {
        this.logger.error(
          `cannot start tournament ${id}`,
          JSON.stringify(error),
        );
      }
    }

    return started;
  }
}
