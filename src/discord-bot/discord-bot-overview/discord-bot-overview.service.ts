import { Injectable, Logger } from "@nestjs/common";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { ButtonActions } from "../enums/ButtonActions";
import { assertUnreachable } from "../../utilities/assertUnreachable";
import { DiscordBotMessagingService } from "../discord-bot-messaging/discord-bot-messaging.service";
import { HasuraService } from "../../hasura/hasura.service";
import { MatchAssistantService } from "../../matches/match-assistant/match-assistant.service";
import { DiscordBotVetoService } from "../discord-bot-veto/discord-bot-veto.service";
import { BULL_CONFIG_DEFAULT_TOKEN, InjectQueue } from "@nestjs/bullmq";
import { DiscordBotQueues } from "../enums/DiscordBotQueues";
import { Queue } from "bullmq";
import { MapSelectionTimeoutSeconds } from "../constants/MapBanSelectionTimeout";
import { DiscordJobs } from "../enums/DiscordJobs";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../configs/types/AppConfig";

@Injectable()
export class DiscordBotOverviewService {
  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly discordMatchBotVeto: DiscordBotVetoService,
    private readonly discordBotMessaging: DiscordBotMessagingService,
    @InjectQueue(DiscordBotQueues.DiscordBot) private readonly queue: Queue,
  ) {}
  public async updateMatchOverview(matchId: string) {
    try {
      const thread = await this.discordBotMessaging.getMatchThread(matchId);

      if (!thread) {
        return;
      }

      const embed = await this.generateMatchOverviewEmbed(matchId);

      if (!embed) {
        return;
      }

      this.logger.verbose(`[${matchId}] update match overview`);
      await this.discordBotMessaging.updateMatchReply(matchId, embed);
    } catch (error) {
      this.logger.warn(`[${matchId}] unable to update match overview`, error);
    }
  }

  private async generateMatchOverviewEmbed(matchId: string) {
    const match = await this.getMatchDetails(matchId);

    const { lineup_1, lineup_2 } = match;

    const embeds = [];
    const components = [];

    const row = new ActionRowBuilder<ButtonBuilder>();

    const matchLink = `${
      this.config.get<AppConfig>("app").webDomain
    }/matches/${match.id}`;

    const matchConnectLink = `${
      this.config.get<AppConfig>("app").webDomain
    }${match.connection_link}`;

    const matchControls = {
      ViewMatch: new ButtonBuilder()
        .setLabel(`View on 5Stack`)
        .setStyle(ButtonStyle.Link)
        .setURL(matchLink),
      JoinMatch: new ButtonBuilder()
        .setLabel(`Join Match`)
        .setStyle(ButtonStyle.Link)
        .setURL(matchConnectLink),
    };

    let color = 3948353;

    const currentMatchMap = match.match_maps.find((match_map) => {
      return match_map.id === match.current_match_map_id;
    });

    if (currentMatchMap) {
      switch (currentMatchMap.status) {
        case "Scheduled":
          color = 16016479;
          break;
        case "Overtime":
        case "Live":
        case "Knife":
          color = 10674342;
          break;
        case "Paused":
        case "Surrendered":
        case "UploadingDemo":
          color = 16016479;
          break;
        case "Canceled":
        case "Finished":
          break;
        case "Warmup":
          color = 16695418;
          break;
        default:
          assertUnreachable(currentMatchMap.status);
      }

      embeds.push({
        title: `${currentMatchMap.map.name}`,
        color,
        description: `${lineup_1?.name} (${currentMatchMap.lineup_1_score}) vs ${lineup_2?.name} (${currentMatchMap.lineup_2_score})`,
      });
    }

    row.addComponents(matchControls.ViewMatch);
    if (match.connection_link) {
      row.addComponents(matchControls.JoinMatch);
    }

    components.push(row);

    const matchOptions = match.options;

    const details = {
      url: "",
      title: matchLink,
      fields: [
        {
          name: "Rules",
          value: `
            ${matchOptions.type}
            MR: ${matchOptions.mr}
            Best of ${matchOptions.best_of}
            Knife: ${matchOptions.knife_round}
            Overtime: ${matchOptions.overtime}
            Coaches: ${matchOptions.coaches}
            Substitutes: ${matchOptions.number_of_substitutes}
            Timeouts: ${matchOptions.timeout_setting}
            Tech Timeouts: ${matchOptions.tech_timeout_setting}
          `,
          inline: true,
        },
        {
          name: " ",
          value: " ",
          inline: true,
        },
      ],
    };

    if (match.server) {
      if (!match.connection_link) {
        await this.matchAssistant.delayCheckOnDemandServer(matchId);
      }

      details.fields.push({
        name: " ",
        value: match.connection_link
          ? match.connection_string
          : match.status === "Scheduled"
            ? "match is scheduled, but warmup has not started"
            : `server is being created`,
        inline: true,
      });

      if (match.connection_link) {
        details.url = matchConnectLink;
      }
    }
    embeds.push(details);

    if (match.map_veto_picks.length > 0) {
      embeds.push({
        fields: [
          {
            name: `__Veto Picks__`,
            value: match.map_veto_picks
              .map((pick) => {
                const lineup =
                  pick.match_lineup_id === lineup_1.id ? lineup_1 : lineup_2;

                return `${lineup.name} ${pick.type} ${pick.map.name}`;
              })
              .join("\n"),
          },
        ],
      });
    }

    embeds.push({
      fields: [
        {
          name: `__${lineup_1.name}__`,
          value: lineup_1.lineup_players
            .map((lineup_player) => {
              return (
                lineup_player.player?.name || lineup_player.placeholder_name
              );
            })
            .join("\n"),
          inline: true,
        },
        {
          name: " ",
          value: " ",
          inline: true,
        },
        {
          name: `__${lineup_2.name}__`,
          value: lineup_2.lineup_players
            .map((lineup_player) => {
              return (
                lineup_player.player?.name || lineup_player.placeholder_name
              );
            })
            .join("\n"),
          inline: true,
        },
      ],
    });

    const overview = {
      content: `**${lineup_1.name}** vs **${lineup_2.name}**`,
      embeds,
      components,
    };

    if (match.status === "Veto") {
      const lineup =
        match.map_veto_picking_lineup_id === lineup_1.id ? lineup_1 : lineup_2;

      const vetoEmbed = await this.generateVetoEmbed(matchId, lineup.name);
      if (vetoEmbed) {
        overview.embeds.push(vetoEmbed.embed);
        overview.components = vetoEmbed.components;

        await this.queue.add(
          DiscordJobs.UpdateDiscordMatchVetoJob,
          {
            matchId,
          },
          {
            removeOnFail: true,
            removeOnComplete: true,
            delay: MapSelectionTimeoutSeconds * 1000,
            jobId: DiscordBotVetoService.UPDATE_MAP_BANS_JOB_ID(matchId),
          },
        );
      }
    }

    return overview;
  }

  public async getMatchDetails(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        status: true,
        password: true,
        lineup_1_id: true,
        lineup_2_id: true,
        current_match_map_id: true,
        connection_link: true,
        connection_string: true,
        tv_connection_link: true,
        map_veto_picking_lineup_id: true,
        options: {
          mr: true,
          type: true,
          best_of: true,
          coaches: true,
          map_veto: true,
          overtime: true,
          knife_round: true,
          timeout_setting: true,
          tech_timeout_setting: true,
          number_of_substitutes: true,
        },
        lineup_1: {
          id: true,
          name: true,
          lineup_players: {
            placeholder_name: true,
            player: {
              name: true,
            },
          },
        },
        lineup_2: {
          id: true,
          name: true,
          lineup_players: {
            placeholder_name: true,
            player: {
              name: true,
            },
          },
        },
        map_veto_picks: {
          type: true,
          map: {
            name: true,
          },
          match_lineup_id: true,
        },
        match_maps: {
          id: true,
          lineup_1_score: true,
          lineup_2_score: true,
          status: true,
          map: {
            name: true,
          },
        },
        server: {
          host: true,
          port: true,
          game_server_node_id: true,
        },
      },
    });

    return match;
  }
  private async generateVetoEmbed(matchId: string, votingLineUpName: string) {
    const mapVotes = await this.discordMatchBotVeto.getMapBanVotes(matchId);
    const availableMaps = await this.matchAssistant.getAvailableMaps(matchId);

    const components = [];

    let selectedCount = 0;

    const _mapVotes = Object.entries(mapVotes);

    _mapVotes.sort((a, b) => b[1] - a[1]);

    const banMaps = _mapVotes
      ?.map((mapIndex) => {
        return availableMaps[parseInt(mapIndex.toString())];
      })
      .filter((map) => {
        return map !== undefined;
      });

    for (const mapIndex in availableMaps) {
      const row = Math.floor(selectedCount++ / 5);

      if (!components[row]) {
        components[row] = new ActionRowBuilder<ButtonBuilder>();
      }

      components[row].addComponents(
        new ButtonBuilder()
          .setCustomId(`${ButtonActions.VetoPick}:${matchId}:${mapIndex}`)
          .setLabel(
            `${availableMaps[mapIndex].name} (${
              mapVotes[mapIndex]?.toString() || "0"
            })`,
          )
          .setStyle(
            (banMaps || []).includes(availableMaps[mapIndex])
              ? ButtonStyle.Danger
              : ButtonStyle.Secondary,
          ),
      );
    }

    return {
      components,
      embed: {
        color: 0,
        description: "",
        // TODO - veto type when we do box series
        title: `${votingLineUpName}: ${"Ban"}`,
        footer: {
          text: `Poll Ends in ${await this.discordMatchBotVeto.getTimeLeft(
            matchId,
          )} seconds`,
        },
      },
    };
  }
}
