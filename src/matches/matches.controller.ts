import { Controller, Get, Logger, Req } from "@nestjs/common";
import { Request } from "express";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { safeJsonStringify } from "../utilities/safeJsonStringify";
import { HasuraService } from "../hasura/hasura.service";
import { MatchAssistantService } from "./match-assistant/match-assistant.service";
import { DiscordBotOverviewService } from "../discord-bot/discord-bot-overview/discord-bot-overview.service";
import { DiscordBotMessagingService } from "../discord-bot/discord-bot-messaging/discord-bot-messaging.service";
import { DiscordBotVoiceChannelsService } from "../discord-bot/discord-bot-voice-channels/discord-bot-voice-channels.service";
import { EventPattern, Payload, Ctx, NatsContext } from "@nestjs/microservices";
import { ModuleRef } from "@nestjs/core";
import { MatchEvents } from "./events";
import MatchEventProcessor from "./events/abstracts/MatchEventProcessor";
import {
  e_match_status_enum,
  match_map_veto_picks_set_input,
  matches_set_input,
  servers_set_input,
} from "../../generated";

@Controller("matches")
export class MatchesController {
  constructor(
    private readonly logger: Logger,
    private readonly moduleRef: ModuleRef,
    private readonly hasura: HasuraService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly discordBotMessaging: DiscordBotMessagingService,
    private readonly discordMatchOverview: DiscordBotOverviewService,
    private readonly discordBotVoiceChannels: DiscordBotVoiceChannelsService,
  ) {}

  @Get("current-match/:serverId")
  public async getMatchDetails(@Req() request: Request) {
    const serverId = request.params.serverId;

    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: serverId,
        },
        api_password: true,
        current_match: {
          id: true,
        },
      },
    });

    if (!server?.current_match?.id) {
      throw Error("unable to find match");
    }

    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: server.current_match.id,
        },
        id: true,
        password: true,
        lineup_1_id: true,
        lineup_2_id: true,
        organizer_steam_id: true,
        current_match_map_id: true,
        options: {
          mr: true,
          type: true,
          best_of: true,
          coaches: true,
          overtime: true,
          tv_delay: true,
          knife_round: true,
          timeout_setting: true,
          tech_timeout_setting: true,
          number_of_substitutes: true,
        },
        match_maps: {
          id: true,
          map: {
            name: true,
            workshop_map_id: true,
          },
          order: true,
          status: true,
          lineup_1_side: true,
          lineup_2_side: true,
          lineup_1_timeouts_available: true,
          lineup_2_timeouts_available: true,
        },
        lineup_1: {
          id: true,
          name: true,
          coach_steam_id: true,
          lineup_players: {
            captain: true,
            steam_id: true,
            match_lineup_id: true,
            placeholder_name: true,
          },
        },
        lineup_2: {
          id: true,
          name: true,
          coach_steam_id: true,
          lineup_players: {
            captain: true,
            steam_id: true,
            match_lineup_id: true,
            placeholder_name: true,
          },
        },
      },
    });

    if (!matches_by_pk) {
      throw Error("unable to find match");
    }

    return JSON.parse(safeJsonStringify(matches_by_pk));
  }

  @HasuraEvent()
  public async match_events(data: HasuraEventData<matches_set_input>) {
    const matchId = (data.new.id || data.old.id) as string;

    const status = data.new.status || data.old.status;

    /**
     * Match was canceled or finished
     */
    if (
      data.op === "DELETE" ||
      status === "Tie" ||
      status === "Forfeit" ||
      status === "Canceled" ||
      status === "Finished"
    ) {
      await this.removeDiscordIntegration(matchId);
      await this.matchAssistant.stopOnDemandServer(
        matchId,
        data.new.server_id || data.old.server_id,
      );
      return;
    }

    /**
     * Server was removed from match
     */
    if (data.old.server_id && data.old.server_id != data.new.server_id) {
      await this.matchAssistant.stopOnDemandServer(matchId, data.old.server_id);
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        status: true,
        server: {
          id: true,
          game_server_node_id: true,
        },
      },
    });

    if (!match) {
      throw Error("unable to find match");
    }

    if (match.status === "Live") {
      if (match.server) {
        if (!(await this.matchAssistant.isDedicatedServerAvailable(matchId))) {
          this.logger.warn(
            `[${matchId}] another match is currently live, moving back to scheduled`,
          );
          // TODO - should we make a state for waiting for server?
          await this.matchAssistant.updateMatchStatus(match.id, "Scheduled");
        }
      } else {
        /**
         * if we don't have a server id it means we need to assign it one
         */
        await this.matchAssistant.assignOnDemandServer(matchId);
      }
    }

    if (match.server?.id) {
      await this.matchAssistant.sendServerMatchId(matchId);
    }

    await this.discordMatchOverview.updateMatchOverview(matchId);
  }

  private async removeDiscordIntegration(matchId: string) {
    await this.discordBotMessaging.removeMatchReply(matchId);
    await this.discordBotVoiceChannels.removeTeamChannels(matchId);
  }

  @HasuraAction()
  public async scheduleMatch(data: {
    user: User;
    match_id: string;
    time?: Date;
  }) {
    const { match_id, user, time } = data;

    if (!(await this.matchAssistant.canSchedule(match_id, user))) {
      throw Error("cannot schedule match until teams are checked in.");
    }

    if (time && new Date(time) < new Date()) {
      throw Error("date must be in the future");
    }

    const { update_matches_by_pk: updatedMatch } = await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match_id,
          },
          _set: {
            scheduled_at: time || new Date(),
            status: time ? "Scheduled" : "WaitingForCheckIn",
          },
        },
        id: true,
        status: true,
      },
    });

    if (
      !updatedMatch ||
      (updatedMatch.status !== "WaitingForCheckIn" &&
        updatedMatch.status !== "Scheduled")
    ) {
      throw Error(`Unable to schedule match`);
    }

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async startMatch(data: {
    match_id: string;
    server_id: string;
    user: User;
  }) {
    const { match_id, server_id, user } = data;

    if (!(await this.matchAssistant.canStart(match_id, user))) {
      throw Error(
        "you are not a match organizer or the match is waiting for players to check in",
      );
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: match_id,
        },
        server_id: true,
        options: {
          map_veto: true,
          best_of: true,
        },
        match_maps: {
          id: true,
        },
      },
    });

    if (!match || !match.options) {
      throw Error("unable to find match");
    }

    let nextPhase: e_match_status_enum = "Live";
    if (
      match.options.map_veto &&
      match.match_maps.length !== match.options.best_of
    ) {
      nextPhase = "Veto";
    }

    const { update_matches_by_pk: updated_match } = await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match_id,
          },
          _set: {
            status: nextPhase,
            server_id: server_id || match.server_id,
          },
        },
        id: true,
        status: true,
        current_match_map_id: true,
        server: {
          game_server_node_id: true,
        },
      },
    });

    if (!updated_match) {
      throw Error("unable to update match");
    }

    if (nextPhase === "Veto") {
      return {
        success: true,
      };
    }

    // TODO - right now the DB doesn't have an idea how many on demands servers we allow
    if (updated_match.status !== nextPhase) {
      throw Error(
        "Server is not available, another match is using this server currently",
      );
    }

    if (updated_match.server?.game_server_node_id === null) {
      await this.matchAssistant.sendServerMatchId(match_id);
    }

    return {
      success: true,
    };
  }

  @HasuraEvent()
  public async match_veto_pick(
    data: HasuraEventData<match_map_veto_picks_set_input>,
  ) {
    const matchId = (data.new.match_id || data.old.match_id) as string;
    await this.discordMatchOverview.updateMatchOverview(matchId);
  }

  @HasuraAction()
  public async cancelMatch(data: { user: User; match_id: string }) {
    const { match_id, user } = data;

    if (!(await this.matchAssistant.canCancel(match_id, user))) {
      throw Error(
        "you are not a match organizer or the match is waiting for players to check in",
      );
    }

    const server = await this.matchAssistant.getMatchServer(match_id);

    await this.matchAssistant.stopOnDemandServer(match_id, server.id);

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async setMatchWinner(data: {
    user: User;
    match_id: string;
    winning_lineup_id: string;
  }) {
    const { match_id, user, winning_lineup_id } = data;

    if (await this.matchAssistant.isOrganizer(match_id, user)) {
      throw Error("you are not a match organizer");
    }

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match_id,
          },
          _set: {
            winning_lineup_id,
          },
        },
        id: true,
        status: true,
      },
    });

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async forfeitMatch(data: {
    user: User;
    match_id: string;
    winning_lineup_id: string;
  }) {
    const { match_id, user, winning_lineup_id } = data;

    if (await this.matchAssistant.isOrganizer(match_id, user)) {
      throw Error("you are not a match organizer");
    }

    const { update_matches_by_pk: match } = await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match_id,
          },
          _set: {
            winning_lineup_id,
            status: "Forfeit",
          },
        },
        id: true,
        status: true,
      },
    });

    if (!match || match.status !== "Forfeit") {
      throw Error("Unable to cancel match");
    }

    return {
      success: true,
    };
  }

  @EventPattern("matches:*")
  public async matchEvent(
    @Payload()
    {
      event,
      data,
    }: {
      event: string;
      data: Record<string, unknown>;
    },
    @Ctx() context: NatsContext,
  ) {
    const Processor = MatchEvents[event as keyof typeof MatchEvents];

    if (!Processor) {
      this.logger.warn("unable to find event handler", event);
      return;
    }

    const processor =
      await this.moduleRef.resolve<MatchEventProcessor<unknown>>(Processor);

    const [, matchId] = context.getArgByIndex(0).split(":");

    processor.setData(matchId, data);

    await processor.process();
  }

  @HasuraAction()
  public async checkIntoMatch(data: { user: User; match_id: string }) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: data.match_id,
        },
        status: true,
      },
    });

    if (matches_by_pk.status !== "WaitingForCheckIn") {
      throw Error("match is not accepting check in's at this time");
    }

    await this.hasura.mutation({
      update_match_lineup_players: {
        __args: {
          where: {
            _and: [
              {
                steam_id: {
                  _eq: data.user.steam_id,
                },
              },
              {
                lineup: {
                  v_match_lineup: {
                    match_id: {
                      _eq: data.match_id,
                    },
                  },
                },
              },
            ],
          },
          _set: {
            checked_in: true,
          },
        },
        affected_rows: true,
      },
    });

    await this.hasura.mutation({
      update_matches: {
        __args: {
          _set: {
            status: "Live",
          },
          where: {
            _and: [
              {
                id: {
                  _eq: data.match_id,
                },
              },
              {
                lineup_1: {
                  is_ready: {
                    _eq: true,
                  },
                },
              },
              {
                lineup_2: {
                  is_ready: {
                    _eq: true,
                  },
                },
              },
            ],
          },
        },
        affected_rows: true,
      },
    });

    return {
      success: false,
    };
  }

  @HasuraEvent()
  public async server_availability(
    data: HasuraEventData<
      Pick<
        servers_set_input,
        "id" | "reserved_by_match_id" | "game_server_node_id"
      >
    >,
  ) {
    if (data.new.reserved_by_match_id !== null) {
      return;
    }

    const { servers_by_pk } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: data.new.id,
        },
        reserved_by_match_id: true,
        game_server_node: {
          region: true,
        },
      },
    });

    if (servers_by_pk.reserved_by_match_id) {
      return;
    }

    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            status: {
              _eq: "WaitingForCheckIn",
            },
            _or: [
              {
                region: {
                  _is_null: true,
                },
              },
              {
                region: {
                  _eq: servers_by_pk.game_server_node.region,
                },
              },
            ],
          },
          limit: 1,
          order_by: [
            {
              created_at: "asc",
            },
          ],
        },
        id: true,
      },
    });

    const match = matches.at(0);

    if (!match) {
      return;
    }

    if (!(await this.matchAssistant.assignOnDemandServer(match.id))) {
      return;
    }

    await this.discordMatchOverview.updateMatchOverview(match.id);
  }
}
