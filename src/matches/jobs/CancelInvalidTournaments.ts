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
  async process(): Promise<number> {
    const { update_tournaments } = await this.hasura.mutation({
      update_tournaments: {
        __args: {
          where: {
            _and: [
              {
                // CheckInReview belongs here too: tournament_has_min_teams
                // excludes no-shows once the window has opened, so a held
                // tournament reporting has_min_teams = false really is short of
                // checked-in teams. Without this it hangs in review forever if
                // the check-in job never ran.
                status: {
                  _in: ["RegistrationOpen", "CheckInReview"],
                },
              },
              {
                has_min_teams: {
                  _eq: false,
                },
              },
              {
                start: {
                  _lte: new Date(),
                },
              },
            ],
          },
          _set: {
            status: "CancelledMinTeams",
          },
        },
        affected_rows: true,
      },
    });

    if (update_tournaments.affected_rows > 0) {
      this.logger.log(
        `${update_tournaments.affected_rows} tournaments cancelled due to insufficient teams`,
      );
    }

    return update_tournaments.affected_rows;
  }
}
