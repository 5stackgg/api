import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { AppConfig } from "../../configs/types/AppConfig";
import { RconService } from "../../rcon/rcon.service";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelExpiredMatches extends WorkerHost {
  // How far ahead of cancels_at a full lobby is allowed to be force started.
  private static readonly FORCE_START_LEAD_MS = 60 * 1000;

  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
    private readonly rcon: RconService,
  ) {
    super();
    this.appConfig = this.configService.get<AppConfig>("app");
  }
  async process(): Promise<number> {
    const matches = await this.getExpiredMatches();
    const now = Date.now();

    let handled = 0;
    for (const match of matches) {
      // Everyone turned up and simply never all hit ready -- there is no
      // no-show to punish here, so push the match past warmup instead of
      // cancelling or forfeiting it out from under them.
      //
      // Checked ahead of the deadline rather than on it: a lobby that fills at
      // the last moment would otherwise be cancelled in the same pass that
      // would have started it.
      if (
        this.isAwaitingWarmup(match) &&
        !this.hasNoShow(match) &&
        (await this.forceStartMatch(match))
      ) {
        handled++;
        continue;
      }

      // Pulled in early for the check above, but still has time on the clock --
      // someone may yet connect.
      if (new Date(match.cancels_at).getTime() > now) {
        continue;
      }

      if (match.is_tournament_match) {
        await this.handleExpiredTournamentMatch(match);
      } else {
        await this.cancelMatch(match);
      }

      handled++;
    }

    if (handled > 0) {
      this.logger.log(`processed ${handled} expired matches`);
    }

    return handled;
  }

  // cancels_at carries two different deadlines depending on where the match is
  // (see the tbu_match_maps trigger): the short no-show deadline while a map is
  // in Warmup, and the much longer hung-live-match safety net once it goes
  // Knife/Live. Force-starting only makes sense for the first. Doing it for the
  // second would fire force_ready at an already-live match and, worse, clear
  // the cancels_at that is the only thing that would ever end it.
  private isAwaitingWarmup(
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
  ) {
    const started = ["Knife", "Live", "Overtime", "Paused"];

    return !(match.match_maps ?? []).some((matchMap) =>
      started.includes(matchMap.status as string),
    );
  }

  // A no-show is a rostered player who never connected to the server at all.
  // Placeholder slots have no steam_id and cannot connect, so they never count.
  private hasNoShow(
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
  ) {
    const players = [
      ...(match.lineup_1.lineup_players ?? []),
      ...(match.lineup_2.lineup_players ?? []),
    ].filter((lineupPlayer) => lineupPlayer.steam_id);

    if (players.length === 0) {
      return true;
    }

    return players.some((lineupPlayer) => !lineupPlayer.is_connected);
  }

  private async forceStartMatch(
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
  ): Promise<boolean> {
    if (!match.server_id) {
      return false;
    }

    try {
      const rcon = await this.rcon.connect(match.server_id);

      if (!rcon) {
        return false;
      }

      await rcon.send("force_ready");

      await this.hasura.mutation({
        update_matches_by_pk: {
          __args: {
            pk_columns: {
              id: match.id,
            },
            _set: {
              cancels_at: null,
            },
          },
          __typename: true,
        },
      });

      this.logger.log(`force started expired match ${match.id}`);
      return true;
    } catch (error) {
      // Falling through to the normal cancel/forfeit path is the safe outcome
      // here -- better to expire the match than to leave it hanging forever.
      this.logger.warn(
        `unable to force start expired match ${match.id}`,
        error,
      );
      return false;
    }
  }

  private async cancelMatch(
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
  ) {
    // Say it in the server before the status flips. Anyone still connected only
    // ever learns about match state from pushed events -- nothing polls
    // current-match -- so a bare status update reaches nobody and the server
    // just disappears out from under them.
    await this.announceCancellation(match);

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match.id,
          },
          _set: {
            status: "Canceled",
          },
        },
        __typename: true,
      },
    });

    // Only after the status flip: getExpiredMatches skips Canceled matches, so
    // this runs exactly once. Recorded first, a failed flip would leave the
    // rows behind and the next pass would insert a second set.
    await this.recordNoShows(match);
  }

  // The match never started, so the people who turned up shouldn't carry
  // anything for it -- only the ones who never showed. Recorded per player
  // rather than per team, since a lobby can die with any mix of the two and
  // there's no honest team-level answer to who was at fault.
  //
  // Leaving a match that did start is a different thing and is already handled
  // elsewhere.
  private async recordNoShows(
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
  ) {
    // cancels_at is also the hung-live-match safety net, so a match that played
    // out and then stalled lands here too. Nobody no-showed that one -- they
    // all turned up -- and by the time it expires they have long since
    // disconnected, so is_connected would read every one of them as absent.
    if (!this.isAwaitingWarmup(match)) {
      return;
    }

    // No server was ever assigned, so nobody could have connected. Penalising
    // the whole lobby for that would be blaming them for our own failure.
    if (!match.server_id) {
      return;
    }

    const noShows = [
      ...(match.lineup_1.lineup_players ?? []),
      ...(match.lineup_2.lineup_players ?? []),
    ].filter(
      (lineupPlayer) => lineupPlayer.steam_id && !lineupPlayer.is_connected,
    );

    if (noShows.length === 0) {
      return;
    }

    try {
      await this.hasura.mutation({
        insert_abandoned_matches: {
          __args: {
            objects: noShows.map((lineupPlayer) => ({
              steam_id: lineupPlayer.steam_id,
              match_id: match.id,
            })),
          },
          affected_rows: true,
        },
      });

      this.logger.log(
        `recorded ${noShows.length} no-show(s) for canceled match ${match.id}`,
      );
    } catch (error) {
      // The cancellation itself matters more than the bookkeeping.
      this.logger.warn(
        `unable to record no-shows for canceled match ${match.id}`,
        error,
      );
    }
  }

  private async announceCancellation(
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
  ) {
    if (!match.server_id) {
      return;
    }

    try {
      const rcon = await this.rcon.connect(match.server_id);

      if (!rcon) {
        return;
      }

      await rcon.send(
        'say Match canceled - not everyone showed up before the deadline.',
      );
    } catch (error) {
      // Never let this stop the cancellation itself.
      this.logger.warn(
        `unable to announce cancellation for match ${match.id}`,
        error,
      );
    }
  }

  private async handleExpiredTournamentMatch(
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
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
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
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
    match: Awaited<ReturnType<typeof this.getExpiredMatches>>[number],
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

  private async getExpiredMatches() {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            _and: [
              {
                status: {
                  _neq: "Canceled",
                },
              },
              {
                cancels_at: {
                  _is_null: false,
                },
              },
              {
                cancels_at: {
                  // Reach ahead of the deadline so a full lobby can be started
                  // rather than cancelled the moment it expires. Anything not
                  // yet actually expired is left alone unless it force starts.
                  _lte: new Date(
                    Date.now() + CancelExpiredMatches.FORCE_START_LEAD_MS,
                  ),
                },
              },
            ],
          },
        },
        id: true,
        cancels_at: true,
        server_id: true,
        is_tournament_match: true,
        match_maps: {
          status: true,
        },
        options: {
          match_mode: true,
        },
        lineup_1: {
          id: true,
          is_ready: true,
          lineup_players: {
            steam_id: true,
            is_connected: true,
          },
        },
        lineup_2: {
          id: true,
          is_ready: true,
          lineup_players: {
            steam_id: true,
            is_connected: true,
          },
        },
      },
    });

    return matches;
  }
}
