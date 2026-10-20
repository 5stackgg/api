import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.Deadlines)
export class CheckForScheduledMatches extends WorkerHost {
  public static readonly LEAD_MS = 15 * 60 * 1000;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const fifteenMinutesAhead = new Date(
      Date.now() + CheckForScheduledMatches.LEAD_MS,
    );
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
              // Mirrors tournament_match_is_pre_start, which tbu_matches
              // refuses outright: without this the whole batch would fail on a
              // round-1 match that was materialized early, taking every other
              // due match with it.
              //
              // Compared against a minute ago rather than now, because the two
              // clocks are not the same one: `start` is measured here and
              // `now()` in Postgres, and only the generous side of that skew is
              // safe. A pre-start match excluded for a minute longer than it had
              // to be loses nothing -- the tournament going Live releases its
              // own round 1.
              {
                _not: {
                  tournament_brackets: {
                    stage: {
                      tournament: {
                        _or: [
                          {
                            status: {
                              _in: ["Setup", "RegistrationOpen"],
                            },
                          },
                          {
                            status: {
                              _in: ["RegistrationClosed", "CheckInReview"],
                            },
                            start: {
                              _gt: new Date(Date.now() - 60 * 1000),
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
              // Not part of that mirror: a cancelled tournament's matches are
              // deleted with it, and one that outlives the cleanup must not
              // open check-in for a tournament that will never be played.
              {
                _not: {
                  tournament_brackets: {
                    stage: {
                      tournament: {
                        status: {
                          _in: ["Cancelled", "CancelledMinTeams"],
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
