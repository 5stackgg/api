import { Controller, Get, Logger, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { safeJsonStringify } from "../utilities/safeJsonStringify";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";
import { HasuraService } from "../hasura/hasura.service";
import { MatchAssistantService } from "./match-assistant/match-assistant.service";
import { DiscordBotOverviewService } from "../discord-bot/discord-bot-overview/discord-bot-overview.service";
import { DiscordBotMessagingService } from "../discord-bot/discord-bot-messaging/discord-bot-messaging.service";
import { DiscordBotVoiceChannelsService } from "../discord-bot/discord-bot-voice-channels/discord-bot-voice-channels.service";
import {
  match_map_veto_picks_set_input,
  match_map_demos_set_input,
  matches_set_input,
  servers_set_input,
  game_server_nodes_set_input,
  match_lineup_players_set_input,
} from "../../generated";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";
import { PostgresService } from "src/postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { DISCORD_COLORS } from "../notifications/utilities/constants";
import { MatchmakeService } from "src/matchmaking/matchmake.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "./enums/MatchQueues";
import { EloCalculation } from "./jobs/EloCalculation";
import { StopOnDemandServer } from "./jobs/StopOnDemandServer";
import { S3Service } from "src/s3/s3.service";
import { ChatService } from "src/chat/chat.service";
import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import { MatchRelayService } from "./match-relay/match-relay.service";
import { DiscordTournamentVoiceService } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.service";
import { GameStreamerService } from "./game-streamer/game-streamer.service";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { DemoMetadataService } from "../demos/demo-metadata.service";
import { ClipsService } from "./clips/clips.service";
import { ClipSpec } from "./clips/types/ClipSpec";

@Controller("matches")
export class MatchesController {
  private readonly appConfig: AppConfig;

  private static readonly TERMINAL_STATUSES: string[] = [
    "Finished",
    "Canceled",
    "Forfeit",
    "Tie",
    "Surrendered",
  ];

  private static readonly BLOCKING_RESET_STATUSES: string[] = ["Live", "Veto"];

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly configService: ConfigService,
    private readonly matchmaking: MatchmakeService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly discordBotMessaging: DiscordBotMessagingService,
    private readonly discordMatchOverview: DiscordBotOverviewService,
    private readonly discordBotVoiceChannels: DiscordBotVoiceChannelsService,
    private readonly notifications: NotificationsService,
    private readonly chatService: ChatService,
    @InjectQueue(MatchQueues.EloCalculation) private eloCalculationQueue: Queue,
    @InjectQueue(MatchQueues.ScheduledMatches)
    private scheduledMatchesQueue: Queue,
    private s3: S3Service,
    private readonly matchRelayService: MatchRelayService,
    private readonly tournamentVoice: DiscordTournamentVoiceService,
    private readonly gameStreamer: GameStreamerService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly clips: ClipsService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  @Get("current-match/:serverId")
  public async getMatchDetails(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const serverId = request.params.serverId;

    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: serverId,
        },
        current_match: {
          id: true,
        },
      },
    });

    if (!server) {
      this.logger.warn(`server tried to get match`, {
        serverId,
        ip: request.headers["cf-connecting-ip"],
      });
      response.status(404).end();
      return;
    }

    if (!server.current_match?.id) {
      response.status(204).end();
      return;
    }

    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: server.current_match.id,
        },
        id: true,
        status: true,
        password: true,
        lineup_1_id: true,
        lineup_2_id: true,
        current_match_map_id: true,
        is_tournament_match: true,
        server: {
          server_region: {
            is_lan: true,
          },
        },
        options: {
          mr: true,
          type: true,
          best_of: true,
          coaches: true,
          overtime: true,
          tv_delay: true,
          knife_round: true,
          default_models: true,
          ready_setting: true,
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
          rounds: {
            round: true,
            backup_file: true,
            deleted_at: true,
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
          team: {
            id: true,
            short_name: true,
          },
          coach_steam_id: true,
          lineup_players: {
            captain: true,
            steam_id: true,
            match_lineup_id: true,
            placeholder_name: true,
            player: {
              name: true,
              role: true,
              is_banned: true,
              is_gagged: true,
              is_muted: true,
              elo: true,
              roster_image_url: true,
              team_members: {
                team_id: true,
                roster_image_url: true,
              },
            },
          },
        },
        lineup_2: {
          id: true,
          name: true,
          team: {
            id: true,
            short_name: true,
          },
          coach_steam_id: true,
          lineup_players: {
            captain: true,
            steam_id: true,
            match_lineup_id: true,
            placeholder_name: true,
            player: {
              name: true,
              role: true,
              is_banned: true,
              is_gagged: true,
              is_muted: true,
              elo: true,
              roster_image_url: true,
              team_members: {
                team_id: true,
                roster_image_url: true,
              },
            },
          },
        },
        tournament_brackets: {
          team_1: {
            name: true,
            short_name: true,
            team: {
              short_name: true,
            },
          },
          team_2: {
            name: true,
            short_name: true,
            team: {
              short_name: true,
            },
          },
        },
      },
    });

    if (!matches_by_pk) {
      throw Error("unable to find match");
    }

    if (MatchesController.TERMINAL_STATUSES.includes(matches_by_pk.status)) {
      response.status(204).end();
      return;
    }

    const match = matches_by_pk as typeof matches_by_pk & {
      is_lan: boolean;
      options: typeof matches_by_pk.options & {
        use_playcast: boolean;
        show_elo_ranks: boolean;
        cfg_overrides: Record<string, string>;
      };
      lineup_1: typeof matches_by_pk.lineup_1 & {
        tag: string;
        lineup_players: Array<
          Omit<(typeof matches_by_pk.lineup_1.lineup_players)[0], "player"> & {
            player: Omit<
              (typeof matches_by_pk.lineup_1.lineup_players)[0]["player"],
              "name"
            >;
          }
        >;
      };
      lineup_2: typeof matches_by_pk.lineup_2 & {
        tag: string;
        lineup_players: Array<
          Omit<(typeof matches_by_pk.lineup_2.lineup_players)[0], "player"> & {
            player: Omit<
              (typeof matches_by_pk.lineup_2.lineup_players)[0]["player"],
              "name"
            >;
          }
        >;
      };
    };

    match.is_lan = match.server.server_region.is_lan;
    delete match.server;

    const fivestackRanksSettingName = match.is_tournament_match
      ? "fivestack_ranks_tournaments"
      : "fivestack_ranks_matches";

    const { settings_by_pk: fivestackRanksSetting } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name: fivestackRanksSettingName,
        },
        name: true,
        value: true,
      },
    });

    match.options.show_elo_ranks = fivestackRanksSetting?.value === "true";

    const { match_type_cfgs } = await this.hasura.query({
      match_type_cfgs: {
        __args: {
          where: {
            type: {
              _in: ["Lan", match.options.type],
            },
          },
        },
        cfg: true,
        type: true,
      },
    });

    if (match_type_cfgs) {
      match.options.cfg_overrides = {
        Lan: "",
        Competitive: "",
        Duel: "",
        Wingman: "",
      };

      for (const cfg of match_type_cfgs) {
        match.options.cfg_overrides[cfg.type] = cfg.cfg;
      }
    }

    const tournamentBracket = match.tournament_brackets?.at(0);
    const lineup1TournamentTag: string | undefined =
      tournamentBracket?.team_1?.team?.short_name ||
      (tournamentBracket?.team_1?.short_name as string | undefined) ||
      tournamentBracket?.team_1?.name;
    const lineup2TournamentTag: string | undefined =
      tournamentBracket?.team_2?.team?.short_name ||
      (tournamentBracket?.team_2?.short_name as string | undefined) ||
      tournamentBracket?.team_2?.name;

    const eloKey = match.options.type?.toLowerCase();
    const getPlayerElo = (
      elo: Record<string, unknown> | null | undefined,
    ): number => {
      const value = eloKey && elo ? elo[eloKey] : undefined;
      const parsed = value != null ? Number(value) : NaN;
      return Number.isFinite(parsed) ? parsed : 5000;
    };

    const lineup1TeamId = match.lineup_1.team?.id;
    match.lineup_1.tag =
      lineup1TournamentTag || match.lineup_1.team?.short_name;
    delete match.lineup_1.team;
    match.lineup_1.lineup_players = match.lineup_1.lineup_players.map(
      (player) => ({
        ...player,
        name: player.player?.name || player.placeholder_name,
        role: player.player?.role || "user",
        is_banned: player.player?.is_banned || false,
        is_gagged: player.player?.is_gagged || false,
        is_muted: player.player?.is_muted || false,
        elo: getPlayerElo(player.player?.elo as Record<string, unknown>),
        roster_image_url:
          (lineup1TeamId &&
            player.player?.team_members?.find(
              (m) => m.team_id === lineup1TeamId,
            )?.roster_image_url) ||
          player.player?.roster_image_url ||
          null,
        player: undefined as undefined,
      }),
    );

    const lineup2TeamId = match.lineup_2.team?.id;
    match.lineup_2.tag =
      lineup2TournamentTag || match.lineup_2.team?.short_name;
    delete match.lineup_2.team;
    match.lineup_2.lineup_players = match.lineup_2.lineup_players.map(
      (player) => ({
        ...player,
        name: player.player?.name || player.placeholder_name,
        role: player.player?.role || "user",
        is_banned: player.player?.is_banned || false,
        is_gagged: player.player?.is_gagged || false,
        is_muted: player.player?.is_muted || false,
        elo: getPlayerElo(player.player?.elo as Record<string, unknown>),
        roster_image_url:
          (lineup2TeamId &&
            player.player?.team_members?.find(
              (m) => m.team_id === lineup2TeamId,
            )?.roster_image_url) ||
          player.player?.roster_image_url ||
          null,
        player: undefined as undefined,
      }),
    );

    const { settings_by_pk: usePlaycast } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name: "use_playcast",
        },
        name: true,
        value: true,
      },
    });

    match.options.use_playcast = usePlaycast?.value === "true" ? true : false;

    const data = JSON.parse(safeJsonStringify(match));

    response.status(200).json(data);
  }

  @HasuraEvent()
  public async match_map_demo_events(
    data: HasuraEventData<match_map_demos_set_input>,
  ) {
    const newRow = data.new ?? {};
    const oldRow = data.old ?? {};
    const matchId = (newRow.match_id ?? oldRow.match_id) as string | undefined;
    const matchMapId = (newRow.match_map_id ?? oldRow.match_map_id) as
      | string
      | undefined;
    const demoId = (newRow.id ?? oldRow.id) as string | undefined;
    if (!matchId || !matchMapId || !demoId) return;

    const isFirstParse =
      !!newRow.metadata_parsed_at && !oldRow.metadata_parsed_at;
    if (!isFirstParse) return;

    const { clip_render_jobs_aggregate } = await this.hasura.query({
      clip_render_jobs_aggregate: {
        __args: { where: { match_map_demo_id: { _eq: demoId } } },
        aggregate: { count: true },
      },
    });
    if ((clip_render_jobs_aggregate?.aggregate?.count ?? 0) > 0) return;

    try {
      const queued = await this.clips.autoGenerateForDemo(
        matchId,
        matchMapId,
        demoId,
        { isSystemInitiated: true },
      );
      if (queued > 0) {
        this.logger.log(
          `[match ${matchId} demo ${demoId}] metadata parsed — auto-clips queued ${queued} job(s)`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[match ${matchId} demo ${demoId}] auto-clips queue failed on metadata_parsed: ${(error as Error)?.message}`,
      );
    }
  }

  @HasuraEvent()
  public async match_events(data: HasuraEventData<matches_set_input>) {
    const matchId = (data.new.id || data.old.id) as string;

    const status = data.new.status;

    if (
      data.op === "UPDATE" &&
      data.new.status === "WaitingForServer" &&
      data.old.status !== "WaitingForServer"
    ) {
      void this.notifications.sendMatchWaitingForServerNotification(matchId);
    }

    if (
      data.op === "UPDATE" &&
      data.new.status === "WaitingForCheckIn" &&
      data.old.status !== "WaitingForCheckIn"
    ) {
      await this.tournamentVoice.createMatchVoiceChannels(matchId);
      await this.tournamentVoice.movePlayersToMatchChannels(matchId);
    }

    if (
      data.op === "UPDATE" &&
      (data.new.status === "Veto" || data.new.status === "Live") &&
      data.old.status !== data.new.status
    ) {
      await this.tournamentVoice.createMatchVoiceChannels(matchId);
      await this.tournamentVoice.movePlayersToMatchChannels(matchId);
    }

    if (data.op === "DELETE") {
      await this.chatService.removeLobby(ChatLobbyType.Match, matchId);
    }

    /**
     * Match was canceled or finished
     */
    if (
      data.op === "DELETE" ||
      MatchesController.TERMINAL_STATUSES.includes(status)
    ) {
      this.matchRelayService.removeBroadcast(matchId);
      await this.removeDiscordIntegration(matchId);
      await this.matchmaking.cancelMatchMakingByMatchId(matchId);

      await this.eloCalculationQueue.add(EloCalculation.name, {
        matchId,
      });

      const serverId = data.new.server_id;

      if (!serverId) {
        return;
      }

      const { servers_by_pk: server } = await this.hasura.query({
        servers_by_pk: {
          __args: {
            id: serverId,
          },
          is_dedicated: true,
        },
      });

      const { match_options_by_pk: matchOptions } = await this.hasura.query({
        match_options_by_pk: {
          __args: {
            id: data.new.match_options_id,
          },
          tv_delay: true,
        },
      });

      let delay = matchOptions?.tv_delay || 1;

      if (status === "Canceled" || data.op === "DELETE") {
        delay = 0;
      }

      this.logger.log(
        `[${matchId}] adding stop / restart server job in ${delay} seconds`,
      );

      if (!server.is_dedicated) {
        await this.scheduledMatchesQueue.add(
          StopOnDemandServer.name,
          { matchId },
          delay ? { delay: delay * 1000 } : undefined,
        );
      }

      await this.hasura.mutation({
        update_matches_by_pk: {
          __args: {
            pk_columns: {
              id: data.new.id || data.old.id,
            },
            _set: {
              server_id: null,
            },
          },
          __typename: true,
        },
      });

      return;
    }

    /**
     * Server was removed from match
     */
    if (
      (data.old.server_id && data.old.server_id !== data.new.server_id) ||
      data.old.region !== data.new.region
    ) {
      try {
        await this.matchAssistant.stopOnDemandServer(matchId);
      } catch (error) {
        this.logger.error(
          `[${matchId}] unable to stop on demand server`,
          error,
        );
      }
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        options: {
          prefer_dedicated_server: true,
        },
        server: {
          id: true,
          is_dedicated: true,
          reserved_by_match_id: true,
          game_server_node_id: true,
        },
      },
    });

    if (!match) {
      throw Error("unable to find match");
    }

    if (
      (status === "Live" &&
        (!match.server || data.old.status !== "WaitingForServer")) ||
      (status === "WaitingForServer" &&
        data.old.server_id !== data.new.server_id)
    ) {
      if (match.server) {
        if (match.server.reserved_by_match_id === matchId) {
          return;
        }

        if (match.server.is_dedicated) {
          await this.matchAssistant.reserveDedicatedServer(matchId);
        }
      } else {
        /**
         * if we don't have a server id it means we need to assign it one
         */
        await this.matchAssistant.assignServer(matchId);
      }
    }

    await this.discordMatchOverview.updateMatchOverview(matchId);
  }

  private async removeDiscordIntegration(matchId: string) {
    await this.discordBotMessaging.removeMatchChannel(matchId);
    await this.discordBotVoiceChannels.removeTeamChannels(matchId);
  }

  /**
   * TODO - does not need to be an action
   */
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
            ...(time && { scheduled_at: time }),
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

  /**
   * TODO - does not need to be a action
   */
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

    const { update_matches_by_pk: updated_match } = await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match_id,
          },
          _set: {
            status: "Live",
            ...(server_id && { server_id }),
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

    if (updated_match.status === "Veto") {
      return {
        success: true,
      };
    }

    if (updated_match.status !== "Live") {
      throw Error(
        "Server is not available, another match is using this server currently",
      );
    }

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async rebootMatchServer(data: { match_id: string; user: User }) {
    const { match_id, user } = data;

    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a match organizer");
    }

    await this.matchAssistant.rebootOnDemandServer(match_id);

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async startLive(data: {
    match_id: string;
    mode: "live" | "tv";
    user: User;
  }) {
    const { match_id, mode, user } = data;

    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a match organizer");
    }

    if (mode !== "live" && mode !== "tv") {
      throw Error("invalid mode");
    }

    await this.gameStreamer.startLive(match_id, mode);

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async stopLive(data: { match_id: string; user: User }) {
    const { match_id, user } = data;

    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a match organizer");
    }

    await this.gameStreamer.stopLive(match_id);

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async reconnectLive(data: { match_id: string; user: User }) {
    const { match_id, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.reconnectLive(match_id);
    return { success: true };
  }

  @HasuraAction()
  public async switchLiveMatch(data: {
    from_match_id: string;
    to_match_id: string;
    mode: "live" | "tv";
    user: User;
  }) {
    const { from_match_id, to_match_id, mode, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    if (!(await this.matchAssistant.isOrganizer(to_match_id, user))) {
      throw Error("you are not an organizer for the destination match");
    }
    await this.gameStreamer.switchLive(from_match_id, to_match_id, mode);
    return { success: true };
  }

  @HasuraAction()
  public async stopGpuSession(data: {
    game_server_node_id: string;
    user: User;
  }) {
    const { game_server_node_id, user } = data;
    if (!isRoleAbove(user.role, "administrator")) {
      throw Error("you must be an administrator");
    }
    await this.gameStreamer.stopGpuSession(game_server_node_id);
    return { success: true };
  }

  @HasuraAction()
  public async specClick(data: {
    match_id: string;
    button: "left" | "right";
    user: User;
  }) {
    const { match_id, button, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.specClick(match_id, button);
    return { success: true };
  }

  @HasuraAction()
  public async specJump(data: { match_id: string; user: User }) {
    const { match_id, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.specJump(match_id);
    return { success: true };
  }

  @HasuraAction()
  public async specPlayer(data: {
    match_id: string;
    accountid: number;
    user: User;
  }) {
    const { match_id, accountid, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.specPlayer(match_id, accountid);
    return { success: true };
  }

  @HasuraAction()
  public async specSlot(data: { match_id: string; slot: number; user: User }) {
    const { match_id, slot, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    if (!Number.isInteger(slot) || slot < 1 || slot > 12) {
      throw Error("slot must be an integer in 1..12");
    }
    await this.gameStreamer.specSlot(match_id, slot);
    return { success: true };
  }

  @HasuraAction()
  public async specAutodirector(data: {
    match_id: string;
    enabled: boolean;
    user: User;
  }) {
    const { match_id, enabled, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.specAutodirector(match_id, enabled);
    return { success: true };
  }

  @HasuraAction()
  public async specHud(data: {
    match_id: string;
    visible: boolean;
    user: User;
  }) {
    const { match_id, visible, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.specHud(match_id, visible);
    return { success: true };
  }

  @HasuraAction()
  public async specHudSides(data: { match_id: string; user: User }) {
    const { match_id, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.specHudSides(match_id);
    return { success: true };
  }

  @HasuraAction()
  public async specXray(data: {
    match_id: string;
    enabled: boolean;
    user: User;
  }) {
    const { match_id, enabled, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.specXray(match_id, enabled);
    return { success: true };
  }

  @HasuraAction()
  public async specScoreboard(data: {
    match_id: string;
    show: boolean;
    user: User;
  }) {
    const { match_id, show, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    await this.gameStreamer.specScoreboard(match_id, show);
    return { success: true };
  }

  @HasuraAction()
  public async watchDemo(data: {
    match_map_id: string;
    match_map_demo_id?: string | null;
    user: User;
  }) {
    const { match_map_id, match_map_demo_id, user } = data;
    this.logger.log(
      `watchDemo invoked: match_map_id=${match_map_id} match_map_demo_id=${match_map_demo_id ?? "<auto>"} user=${user?.steam_id}`,
    );

    const demo = match_map_demo_id
      ? await this.demoMetadata.getDemoById(match_map_demo_id)
      : await this.demoMetadata.getDemoForMap(match_map_id);
    if (!demo) {
      throw Error(`no uploaded demo for match_map ${match_map_id}`);
    }
    if (match_map_demo_id && demo.match_map_id !== match_map_id) {
      throw Error("demo does not belong to the requested match map");
    }
    const isOrganizer = await this.matchAssistant.isOrganizer(
      demo.match_id,
      user,
    );
    if (!isOrganizer && !isRoleAbove(user.role, "streamer")) {
      throw Error(
        "you must be the match organizer or have the streamer role or above",
      );
    }

    if (!demo.metadata_parsed_at || !demo.total_ticks) {
      throw Error("demo metadata not ready — try again in a moment");
    }

    const presignedDemoUrl = await this.s3.getPresignedUrl(
      demo.file,
      undefined,
      60 * 60,
      "get",
    );

    const session = await this.gameStreamer.startDemoPlayback(
      match_map_id,
      user.steam_id,
      {
        demoId: demo.id,
        demoFile: demo.file,
        presignedDemoUrl,
        roundTicks: demo.round_ticks ?? null,
        totalTicks: demo.total_ticks ?? null,
        tickRate: demo.tick_rate ?? null,
        workshopId: demo.workshop_id ?? null,
        cs2Build: demo.cs2_build ?? null,
      },
    );

    return {
      success: true,
      session_id: session.sessionId,
      stream_url: session.streamUrl,
    };
  }

  @HasuraAction()
  public async stopWatchDemo(data: { match_map_id: string; user: User }) {
    const { match_map_id, user } = data;
    await this.gameStreamer.stopDemoPlayback(match_map_id, user.steam_id);
    return { success: true };
  }

  @HasuraAction()
  public async createClips(data: { match_id: string; user: User }) {
    const { match_id, user } = data;

    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a match organizer");
    }

    const queued = await this.clips.autoGenerateForMatch(match_id, {
      force: true,
      actingUserSteamId: user.steam_id,
    });

    return {
      success: true,
      queued,
    };
  }

  @HasuraAction()
  public async createClipRender(data: { spec: ClipSpec; user: User }) {
    const { spec, user } = data;
    if (!isRoleAbove(user.role, "verified_user")) {
      throw Error("clip rendering requires a verified account");
    }
    if (!spec || !spec.match_map_id) {
      throw Error("invalid clip spec");
    }
    const { jobId } = await this.clips.createClipRender(user.steam_id, spec);
    return {
      success: true,
      job_id: jobId,
    };
  }

  @HasuraAction()
  public async cancelClipRender(data: { job_id: string; user: User }) {
    await this.clips.cancelClipRender(data.user.steam_id, data.job_id);
    return { success: true };
  }

  @HasuraAction()
  public async cancelClipRenderBatch(data: {
    match_map_id: string;
    user: User;
  }) {
    if (!isRoleAbove(data.user.role, "streamer")) {
      throw Error("only operators can cancel a render batch");
    }
    const cancelled = await this.clips.cancelClipRenderBatch(data.match_map_id);
    return { success: true, cancelled };
  }

  @HasuraAction()
  public async clearClipRenderBatch(data: {
    match_map_id: string;
    user: User;
  }) {
    if (!isRoleAbove(data.user.role, "administrator")) {
      throw Error("only administrators can clear render queue batches");
    }
    await this.clips.clearClipRenderBatch(data.match_map_id);
    return { success: true };
  }

  @HasuraAction()
  public async clearFinishedClipRenders(data: { user: User }) {
    if (!isRoleAbove(data.user.role, "administrator")) {
      throw Error("only administrators can clear the render queue");
    }
    await this.clips.clearFinishedClipRenders();
    return { success: true };
  }

  @HasuraAction()
  public async requeueClipRender(data: { job_id: string; user: User }) {
    if (!isRoleAbove(data.user.role, "administrator")) {
      throw Error("only administrators can re-queue clip renders");
    }
    await this.clips.requeueClipRender(data.job_id);
    return { success: true };
  }

  @HasuraAction()
  public async retryClipRenderBatch(data: {
    match_map_id: string;
    only_failed?: boolean | null;
    user: User;
  }) {
    if (!isRoleAbove(data.user.role, "administrator")) {
      throw Error("only administrators can retry render batches");
    }
    const retried = await this.clips.retryClipRenderBatch(
      data.match_map_id,
      data.only_failed === true,
    );
    return { success: true, retried };
  }

  @HasuraAction()
  public async getLiveStreamSpecState(data: { match_id: string; user: User }) {
    const { match_id } = data;
    const state = await this.gameStreamer.getLiveSpecState(match_id);
    return state;
  }

  @HasuraAction()
  public async setHudMode(data: {
    match_id: string;
    mode: string;
    user: User;
  }) {
    const { match_id, mode, user } = data;
    if (!isRoleAbove(user.role, "streamer")) {
      throw Error("you must have the streamer role or above");
    }
    if (mode !== "default" && mode !== "horizontal" && mode !== "vertical") {
      throw Error("mode must be one of default|horizontal|vertical");
    }
    await this.gameStreamer.setLiveHudMode(match_id, mode);
    return { success: true };
  }

  @HasuraAction()
  public async createClipFromPreset(data: {
    match_map_id: string;
    target_steam_id: string;
    preset: "knife" | "multikills" | "best_round" | "recap";
    resolution?: "720p" | "1080p";
    fps?: 30 | 60;
    title?: string;
    target_name?: string;
    user: User;
  }) {
    const { user } = data;
    if (!isRoleAbove(user.role, "verified_user")) {
      throw Error("clip rendering requires a verified account");
    }
    const spec = await this.clips.buildPresetSpec(
      data.match_map_id,
      data.target_steam_id,
      data.preset,
      {
        resolution: data.resolution ?? "1080p",
        fps: data.fps ?? 60,
      },
      data.title,
      data.target_name,
    );
    const { jobId } = await this.clips.createClipRender(user.steam_id, spec);
    return { success: true, job_id: jobId };
  }

  @HasuraAction()
  public async deleteClip(data: { clip_id: string; user: User }) {
    const isOperator = isRoleAbove(data.user.role, "streamer");
    await this.clips.deleteClip(data.user.steam_id, data.clip_id, isOperator);
    return { success: true };
  }

  @HasuraAction()
  public async updateClip(data: {
    clip_id: string;
    title?: string | null;
    visibility?: "private" | "unlisted" | "match" | "public";
    target_steam_id?: string | null;
    user: User;
  }) {
    const isOperator = isRoleAbove(data.user.role, "streamer");
    await this.clips.updateClip(
      data.user.steam_id,
      data.clip_id,
      {
        title: data.title,
        visibility: data.visibility,
        target_steam_id: data.target_steam_id,
      },
      isOperator,
    );
    return { success: true };
  }

  @HasuraEvent()
  public async match_veto_pick(
    data: HasuraEventData<match_map_veto_picks_set_input>,
  ) {
    const matchId = (data.new.match_id || data.old.match_id) as string;
    await this.discordMatchOverview.updateMatchOverview(matchId);
  }

  /**
   * TODO - does not need to be a action
   */
  @HasuraAction()
  public async cancelMatch(data: { user: User; match_id: string }) {
    const { match_id, user } = data;

    if (!(await this.matchAssistant.canCancel(match_id, user))) {
      throw Error(
        "you are not a match organizer or the match is waiting for players to check in",
      );
    }

    await this.matchAssistant.updateMatchStatus(match_id, "Canceled");

    return {
      success: true,
    };
  }

  /**
   * TODO - does not need to be a action
   */
  @HasuraAction()
  public async setMatchWinner(data: {
    user: User;
    match_id: string;
    winning_lineup_id: string;
  }) {
    const { match_id, user, winning_lineup_id } = data;

    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a match organizer");
    }

    const { matches_by_pk: current } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: match_id },
        winning_lineup_id: true,
      },
    });

    if (!current) {
      throw Error("match not found");
    }

    const isReassignment =
      current.winning_lineup_id != null &&
      current.winning_lineup_id !== winning_lineup_id;

    if (
      isReassignment &&
      !(await this.matchAssistant.canReassignWinner(match_id, user))
    ) {
      throw Error(
        "cannot change winner: match is not finished or a downstream tournament match has already started",
      );
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
  public async setMapWinner(data: {
    user: User;
    match_id: string;
    match_map_id: string;
    winning_lineup_id: string;
  }) {
    const { match_id, match_map_id, user, winning_lineup_id } = data;

    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a match organizer");
    }

    const { match_maps_by_pk: targetMap } = await this.hasura.query({
      match_maps_by_pk: {
        __args: { id: match_map_id },
        id: true,
        match_id: true,
      },
    });

    if (!targetMap || targetMap.match_id !== match_id) {
      throw Error("map not found for this match");
    }

    await this.hasura.mutation({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: { id: match_map_id },
          _set: { winning_lineup_id },
        },
        id: true,
      },
    });

    const { matches_by_pk: matchAfter } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: match_id },
        lineup_1_id: true,
        lineup_2_id: true,
        winning_lineup_id: true,
        options: { best_of: true },
        match_maps: {
          winning_lineup_id: true,
        },
      },
    });

    if (!matchAfter) {
      return { success: true };
    }

    const bestOf = matchAfter.options?.best_of ?? 0;
    const needed = Math.floor(bestOf / 2) + 1;

    let lineup1Wins = 0;
    let lineup2Wins = 0;
    for (const map of matchAfter.match_maps ?? []) {
      if (map.winning_lineup_id === matchAfter.lineup_1_id) {
        lineup1Wins += 1;
      } else if (map.winning_lineup_id === matchAfter.lineup_2_id) {
        lineup2Wins += 1;
      }
    }

    let computedMatchWinner: string | null = null;
    if (lineup1Wins >= needed) {
      computedMatchWinner = matchAfter.lineup_1_id;
    } else if (lineup2Wins >= needed) {
      computedMatchWinner = matchAfter.lineup_2_id;
    }

    if (computedMatchWinner !== matchAfter.winning_lineup_id) {
      await this.hasura.mutation({
        update_matches_by_pk: {
          __args: {
            pk_columns: { id: match_id },
            _set: { winning_lineup_id: computedMatchWinner },
          },
          id: true,
        },
      });
    }

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async PreviewTournamentMatchReset(data: {
    user: User;
    match_id: string;
  }) {
    const { match_id, user } = data;

    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a tournament organizer");
    }

    type PreviewRow = {
      bracket_id: string;
      match_id: string | null;
      depth: number;
      round: number;
      match_number: number;
      path: string | null;
      stage_type: string;
      match_status: string | null;
      is_source: boolean;
      will_delete_match: boolean;
    };

    const rows = await this.postgres.query<PreviewRow[]>(
      `SELECT * FROM preview_tournament_match_reset($1::uuid)`,
      [match_id],
    );

    if (!rows.length) {
      throw Error("match is not linked to a tournament bracket");
    }

    const blockingStatuses = new Set(MatchesController.BLOCKING_RESET_STATUSES);
    const hasBlockingMatch = rows.some(
      (row) =>
        row.will_delete_match && blockingStatuses.has(row.match_status || ""),
    );

    if (hasBlockingMatch) {
      throw Error("cannot reset while an affected downstream match is live");
    }

    return {
      impacts: rows,
    };
  }

  @HasuraAction()
  public async ResetTournamentMatch(data: {
    user: User;
    match_id: string;
    winning_lineup_id?: string | null;
    reset_status?: string | null;
    scheduled_at?: string | null;
  }) {
    const { match_id, user, winning_lineup_id, reset_status, scheduled_at } =
      data;
    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a tournament organizer");
    }

    const previewRows = await this.postgres.query<
      { will_delete_match: boolean; match_status: string | null }[]
    >(
      `SELECT will_delete_match, match_status FROM preview_tournament_match_reset($1::uuid)`,
      [match_id],
    );

    if (!previewRows.length) {
      throw Error("match is not linked to a tournament bracket");
    }

    const blockingStatuses = new Set(MatchesController.BLOCKING_RESET_STATUSES);
    const hasBlockingMatch = previewRows.some(
      (row) =>
        row.will_delete_match && blockingStatuses.has(row.match_status || ""),
    );

    if (hasBlockingMatch) {
      throw Error("cannot reset while an affected downstream match is live");
    }

    const resolvedScheduledAt =
      scheduled_at && scheduled_at.trim().length > 0 ? scheduled_at : null;
    const resolvedResetStatus =
      reset_status === "Scheduled"
        ? resolvedScheduledAt
          ? "Scheduled"
          : "WaitingForCheckIn"
        : reset_status === "WaitingForCheckIn"
          ? "WaitingForCheckIn"
          : "Setup";

    await this.postgres.query(
      `SELECT * FROM reset_tournament_match($1::uuid, NULLIF($2::text, '')::uuid, $3::text, $4::timestamptz)`,
      [
        match_id,
        winning_lineup_id ?? "",
        resolvedResetStatus,
        resolvedScheduledAt,
      ],
    );

    return {
      success: true,
    };
  }

  /**
   * TODO - does not need to be a action
   */
  @HasuraAction()
  public async forfeitMatch(data: {
    user: User;
    match_id: string;
    winning_lineup_id: string;
  }) {
    const { match_id, user, winning_lineup_id } = data;

    if (!(await this.matchAssistant.isOrganizer(match_id, user))) {
      throw Error("you are not a match organizer");
    }

    const { matches_by_pk: matchToForfeit } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: match_id,
        },
        status: true,
      },
    });

    if (!matchToForfeit) {
      throw Error("match not found");
    }

    if (MatchesController.TERMINAL_STATUSES.includes(matchToForfeit.status)) {
      throw Error("cannot forfeit a match that has already ended");
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

  @HasuraAction()
  public async callForOrganizer(data: { user: User; match_id: string }) {
    const { matches_by_pk: match } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: data.match_id,
          },
          is_in_lineup: true,
          requested_organizer: true,
        },
      },
      data.user.steam_id,
    );

    if (!match || match.requested_organizer) {
      return {
        success: true,
      };
    }

    void this.notifications.send(
      "MatchSupport",
      {
        message: `Match Assistanced Required <a href="${this.appConfig.webDomain}/matches/${data.match_id}">${data.match_id}</a>`,
        title: "Match Assistanced Required",
        role: "match_organizer",
        entity_id: data.match_id,
      },
      undefined,
      DISCORD_COLORS.RED,
    );

    return {
      success: true,
    };
  }

  /**
   * TODO - does not need to be a action
   */
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

    const { update_match_lineup_players } = await this.hasura.mutation({
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
                  match: {
                    id: {
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
      success: (update_match_lineup_players?.affected_rows ?? 0) > 0,
    };
  }

  @HasuraEvent()
  public async server_availability(data: HasuraEventData<servers_set_input>) {
    if (
      data.new.enabled === false ||
      data.new.connected === false ||
      data.new.reserved_by_match_id !== null
    ) {
      return;
    }

    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            status: {
              _eq: "WaitingForServer",
            },
            _or: [
              {
                region: {
                  _is_null: true,
                },
              },
              {
                region: {
                  _eq: data.new.region,
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

    await this.matchAssistant.assignServer(match.id);
  }

  @HasuraEvent()
  public async node_server_availability(
    data: HasuraEventData<game_server_nodes_set_input>,
  ) {
    if (data.new.enabled === false || data.new.status !== "Online") {
      return;
    }

    const becameOnline = data.op === "INSERT" || data.old?.status !== "Online";

    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: {
          id: data.new.id,
        },
        gpu: true,
        servers_aggregate: {
          __args: {
            where: {
              reserved_by_match_id: {
                _is_null: true,
              },
            },
          },
          aggregate: {
            count: true,
          },
        },
      },
    });

    if (becameOnline && game_server_nodes_by_pk?.gpu) {
      void this.clips.reconcileQueuedHighlights().catch((error) => {
        this.logger.warn(
          `[node-online ${data.new.id}] reconcile-highlights failed: ${(error as Error)?.message}`,
        );
      });
    }

    const totalMatchesToFind =
      game_server_nodes_by_pk.servers_aggregate.aggregate.count;

    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            status: {
              _eq: "WaitingForServer",
            },
            _or: [
              {
                region: {
                  _is_null: true,
                },
              },
              {
                region: {
                  _eq: data.new.region,
                },
              },
            ],
          },
          limit: totalMatchesToFind,
          order_by: [
            {
              created_at: "asc",
            },
          ],
        },
        id: true,
      },
    });

    for (const match of matches) {
      await this.matchAssistant.assignServer(match.id);
    }
  }

  @HasuraAction()
  public async joinLineup(data: {
    user: User;
    match_id: string;
    lineup_id: string;
    code: string;
  }) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: data.match_id,
        },
        options: {
          lobby_access: true,
          invite_code: true,
        },
      },
    });

    if (matches_by_pk.options.lobby_access === "Private") {
      throw Error("Cannot Join a Private Lobby");
    }

    if (matches_by_pk.options.lobby_access === "Invite") {
      if (
        !timingSafeStringEqual(data.code, matches_by_pk.options.invite_code)
      ) {
        throw Error("Invalid Code for Match");
      }
    }

    const { insert_match_lineup_players_one } = await this.hasura.mutation({
      insert_match_lineup_players_one: {
        __args: {
          object: {
            steam_id: data.user.steam_id,
            match_lineup_id: data.lineup_id,
          },
        },
        id: true,
      },
    });

    return {
      success: !!insert_match_lineup_players_one.id,
    };
  }

  @HasuraAction()
  public async leaveLineup(data: { user: User; match_id: string }) {
    const { delete_match_lineup_players } = await this.hasura.mutation({
      delete_match_lineup_players: {
        __args: {
          where: {
            steam_id: {
              _eq: data.user.steam_id,
            },
            lineup: {
              match: {
                id: {
                  _eq: data.match_id,
                },
              },
            },
          },
        },
        returning: {
          id: true,
        },
      },
    });

    return {
      success: delete_match_lineup_players.returning.length > 0,
    };
  }

  @HasuraAction()
  public async switchLineup(data: { user: User; match_id: string }) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: data.match_id,
          },
          id: true,
          options: {
            lobby_access: true,
          },
          max_players_per_lineup: true,
          lineup_1: {
            id: true,
            is_on_lineup: true,
            lineup_players: {
              steam_id: true,
            },
          },
          lineup_2: {
            id: true,
            is_on_lineup: true,
            lineup_players: {
              steam_id: true,
            },
          },
        },
      },
      data.user.steam_id,
    );

    if (matches_by_pk.options.lobby_access === "Private") {
      throw Error("cannot switch when match is set to private");
    }

    if (
      !matches_by_pk.lineup_1.is_on_lineup &&
      !matches_by_pk.lineup_2.is_on_lineup
    ) {
      throw Error("not able to switch a lineup which you are not on");
    }

    if (matches_by_pk.lineup_1.is_on_lineup) {
      if (
        matches_by_pk.lineup_2.lineup_players.length >=
        matches_by_pk.max_players_per_lineup
      ) {
        throw Error(
          "unable to swithch because the lineup  has the maximum nubmer of players",
        );
      }
    }

    if (matches_by_pk.lineup_2.is_on_lineup) {
      if (
        matches_by_pk.lineup_1.lineup_players.length >=
        matches_by_pk.max_players_per_lineup
      ) {
        throw Error(
          "unable to swithch because the lineup  has the maximum nubmer of players",
        );
      }
    }

    const { update_match_lineup_players } = await this.hasura.mutation({
      update_match_lineup_players: {
        __args: {
          where: {
            steam_id: { _eq: data.user.steam_id },
            match_lineup_id: {
              _eq: matches_by_pk.lineup_1.is_on_lineup
                ? matches_by_pk.lineup_1.id
                : matches_by_pk.lineup_2.id,
            },
          },
          _set: {
            match_lineup_id: matches_by_pk.lineup_1.is_on_lineup
              ? matches_by_pk.lineup_2.id
              : matches_by_pk.lineup_1.id,
          },
        },
        affected_rows: true,
      },
    });

    return {
      success: !!update_match_lineup_players.affected_rows,
    };
  }

  @HasuraAction()
  public async randomizeTeams(data: { user: User; match_id: string }) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: data.match_id,
          },
          id: true,
          is_organizer: true,
        },
      },
      data.user.steam_id,
    );

    if (!matches_by_pk.is_organizer) {
      throw Error("not the match organizer");
    }

    await this.postgres.query(`SELECT randomize_teams($1)`, [data.match_id]);

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async swapLineups(data: { user: User; match_id: string }) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: data.match_id,
          },
          is_organizer: true,
          lineup_1_id: true,
          lineup_2_id: true,
        },
      },
      data.user.steam_id,
    );

    if (!matches_by_pk.is_organizer) {
      throw Error("not the match organizer");
    }

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: data.match_id,
          },
          _set: {
            lineup_1_id: matches_by_pk.lineup_2_id,
            lineup_2_id: matches_by_pk.lineup_1_id,
          },
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async deleteMatch(data: { match_id: string }) {
    const { match_id } = data;
    this.logger.log(`[${match_id}] deleting match`);

    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: match_id,
        },
        id: true,
        status: true,
      },
    });

    if (matches_by_pk.status === "Live") {
      throw Error("cannot delete a live match");
    }

    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          limit: 10,
          where: {
            match_id: {
              _eq: match_id,
            },
          },
        },
        id: true,
        file: true,
      },
    });

    for (const demo of match_map_demos) {
      await this.s3.remove(demo.file);
      await this.hasura.mutation({
        delete_match_map_demos_by_pk: {
          __args: {
            id: demo.id,
          },
          __typename: true,
        },
      });
    }

    await this.hasura.mutation({
      delete_matches_by_pk: {
        __args: {
          id: match_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  @HasuraEvent()
  public async match_lineup_players(
    data: HasuraEventData<match_lineup_players_set_input>,
  ) {
    const match_lineup_id = (data.new.match_lineup_id ||
      data.old.match_lineup_id) as string;
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            _or: [
              {
                lineup_1_id: {
                  _eq: match_lineup_id,
                },
              },
              {
                lineup_2_id: {
                  _eq: match_lineup_id,
                },
              },
            ],
          },
        },
        id: true,
        status: true,
      },
    });
    const match = matches.at(0);

    if (!match) {
      return;
    }

    if (!["Live"].includes(match.status)) {
      return;
    }

    await this.matchAssistant.sendServerMatchId(match.id);
  }
}
