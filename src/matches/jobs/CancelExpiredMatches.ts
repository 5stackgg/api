import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { AppConfig } from "../../configs/types/AppConfig";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelExpiredMatches extends WorkerHost {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
  ) {
    super();
    this.appConfig = this.configService.get<AppConfig>("app");
  }
  async process(): Promise<number> {
    const { update_matches } = await this.hasura.mutation({
      update_matches: {
        __args: {
          where: {
            _and: [
              {
                status: {
                  _neq: "Canceled",
                },
              },
              {
                is_tournament_match: {
                  _eq: false,
                },
              },
              {
                cancels_at: {
                  _is_null: false,
                },
              },
              {
                cancels_at: {
                  _lte: new Date(),
                },
              },
            ],
          },
          _set: {
            status: "Canceled",
          },
        },
        affected_rows: true,
      },
    });

    const tournamentMatches = await this.getTournamentMatches();
    for (const tournamentMatch of tournamentMatches) {
      await this.handleExpiredTournamentMatch(tournamentMatch);
    }

    const totalExpiredMatches =
      update_matches.affected_rows + tournamentMatches.length;
    if (totalExpiredMatches > 0) {
      this.logger.log(`processed ${totalExpiredMatches} expired matches`);
    }

    return totalExpiredMatches;
  }

  private async handleExpiredTournamentMatch(
    match: Awaited<ReturnType<typeof this.getTournamentMatches>>[number],
  ) {
    const hasReadyLineup = match.lineup_1.is_ready || match.lineup_2.is_ready;
    const isAdminMode = match.options?.match_mode === "admin";

    if (!hasReadyLineup && isAdminMode) {
      await this.requestOrganizerAttention(match.id);
      return;
    }

    await this.forfeitMatch(match);
  }

  private async forfeitMatch(
    match: Awaited<ReturnType<typeof this.getTournamentMatches>>[number],
  ) {
    const winningLineupId = this.getWinningLineupId(match);
    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match.id,
          },
          _set: {
            status: "Forfeit",
            winning_lineup_id: winningLineupId,
          },
        },
        __typename: true,
      },
    });
  }

  private getWinningLineupId(
    match: Awaited<ReturnType<typeof this.getTournamentMatches>>[number],
  ) {
    if (match.lineup_1.is_ready) {
      return match.lineup_1.id;
    }

    if (match.lineup_2.is_ready) {
      return match.lineup_2.id;
    }

    // Neither side checked in. In auto mode there is no one watching the
    // bracket, so coin-toss a winner to keep the tournament moving rather
    // than stalling it (admin mode routes to a human instead).
    return Math.random() < 0.5 ? match.lineup_1.id : match.lineup_2.id;
  }

  private async requestOrganizerAttention(matchId: string) {
    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: matchId,
          },
          _set: {
            cancels_at: null,
          },
        },
        __typename: true,
      },
    });

    if (await this.hasPendingOrganizerNotification(matchId)) {
      return;
    }

    await this.notifications.send(
      "MatchSupport",
      {
        message: `Tournament match requires admin attention <a href="${this.appConfig.webDomain}/matches/${matchId}">${matchId}</a>`,
        title: "Tournament match requires attention",
        role: "tournament_organizer",
        entity_id: matchId,
      },
      undefined,
      DISCORD_COLORS.RED,
    );
  }

  private async hasPendingOrganizerNotification(matchId: string) {
    const { notifications_aggregate } = await this.hasura.query({
      notifications_aggregate: {
        __args: {
          where: {
            entity_id: { _eq: matchId },
            type: { _eq: "MatchSupport" },
            is_read: { _eq: false },
          },
        },
        aggregate: {
          count: true,
        },
      },
    });

    return notifications_aggregate.aggregate.count > 0;
  }

  private async getTournamentMatches() {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            _and: [
              {
                is_tournament_match: {
                  _eq: true,
                },
              },
              {
                cancels_at: {
                  _is_null: false,
                },
              },
              {
                cancels_at: {
                  _lte: new Date(),
                },
              },
            ],
          },
        },
        id: true,
        is_tournament_match: true,
        options: {
          match_mode: true,
        },
        lineup_1: {
          id: true,
          is_ready: true,
        },
        lineup_2: {
          id: true,
          is_ready: true,
        },
      },
    });

    return matches;
  }
}
