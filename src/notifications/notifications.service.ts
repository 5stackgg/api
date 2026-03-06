import TurndownService from "turndown";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";
import { AppConfig } from "src/configs/types/AppConfig";
import {
  e_match_status_enum,
  e_notification_types_enum,
  e_player_roles_enum,
  tournaments,
} from "generated/schema";
import {
  NOTIFIABLE_STATUSES,
  STATUS_LABELS,
  STATUS_COLORS,
  DISCORD_COLORS,
} from "./utilities/constants";

@Injectable()
export class NotificationsService {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly hasura: HasuraService,
    private readonly logger: Logger,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  async send(
    type: e_notification_types_enum,
    notification: {
      message: string;
      title: string;
      role: e_player_roles_enum;
      entity_id?: string;
    },
    actions?: Array<{
      label: string;
      graphql: {
        type: string;
        action: string;
        selection: Record<string, any>;
        variables?: Record<string, any>;
      };
    }>,
    color?: number,
  ) {
    const { settings_by_pk: discord_support_webhook } = await this.hasura.query(
      {
        settings_by_pk: {
          __args: {
            name: "discord_support_webhook",
          },
          value: true,
        },
      },
    );

    const { settings_by_pk: discord_role_id } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name: "discord_support_role_id",
        },
        value: true,
      },
    });

    await this.hasura.mutation({
      insert_notifications_one: {
        __args: {
          object: {
            type,
            ...notification,
            actions,
          },
        },
        id: true,
      },
    });

    if (discord_support_webhook?.value) {
      try {
        const description = new TurndownService().turndown(
          notification.message,
        );
        const content = discord_role_id?.value
          ? `<@&${discord_role_id.value}>`
          : undefined;

        await fetch(discord_support_webhook.value, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...(content && { content }),
            embeds: [
              {
                title: notification.title,
                description,
                color: color ?? DISCORD_COLORS.GRAY,
              },
            ],
            username: "5stack",
          }),
        });
      } catch (error) {
        this.logger.error("Error sending discord notification", error);
      }
    }
  }

  async sendMatchStatusNotification(
    matchId: string,
    newStatus: e_match_status_enum,
    _oldStatus: e_match_status_enum,
  ) {
    if (!NOTIFIABLE_STATUSES.has(newStatus)) {
      return;
    }

    try {
      const { tournament_brackets } = await this.hasura.query({
        tournament_brackets: {
          __args: {
            where: {
              match_id: { _eq: matchId },
            },
            limit: 1,
          },
          stage: {
            tournament: {
              id: true,
              name: true,
              organizer_steam_id: true,
              organizers: {
                steam_id: true,
              },
              discord_notifications_enabled: true,
              discord_webhook: true,
              discord_role_id: true,
              discord_notify_PickingPlayers: true,
              discord_notify_Scheduled: true,
              discord_notify_WaitingForCheckIn: true,
              discord_notify_WaitingForServer: true,
              discord_notify_Veto: true,
              discord_notify_Live: true,
              discord_notify_Finished: true,
              discord_notify_Tie: true,
              discord_notify_Canceled: true,
              discord_notify_Forfeit: true,
              discord_notify_Surrendered: true,
              discord_notify_MapPaused: true,
            },
          },
        },
      });

      const tournament = tournament_brackets?.at(0)?.stage.tournament;

      const readableStatus = STATUS_LABELS[newStatus] || newStatus;
      const matchUrl = `${this.appConfig.webDomain}/matches/${matchId}`;
      const title = `Match Status: ${readableStatus}`;

      if (!tournament) {
        const message = `Match status changed to <b>${readableStatus}</b>. <a href="${matchUrl}">View Match</a>`;

        const { matches_by_pk } = await this.hasura.query({
          matches_by_pk: {
            __args: { id: matchId },
            organizer_steam_id: true,
            lineup_1: {
              lineup_players: {
                steam_id: true,
              },
            },
            lineup_2: {
              lineup_players: {
                steam_id: true,
              },
            },
          },
        });

        if (!matches_by_pk) {
          return;
        }

        const playerSteamIds = new Set<string>();

        if (matches_by_pk.organizer_steam_id) {
          playerSteamIds.add(String(matches_by_pk.organizer_steam_id));
        }

        for (const player of matches_by_pk.lineup_1?.lineup_players || []) {
          if (player.steam_id) {
            playerSteamIds.add(String(player.steam_id));
          }
        }
        for (const player of matches_by_pk.lineup_2?.lineup_players || []) {
          if (player.steam_id) {
            playerSteamIds.add(String(player.steam_id));
          }
        }

        for (const steamId of playerSteamIds) {
          await this.insertNotification({
            type: "MatchStatusChange" as e_notification_types_enum,
            title,
            message,
            steam_id: steamId,
            role: "user",
            entity_id: matchId,
          });
        }

        await this.insertNotification({
          type: "MatchStatusChange" as e_notification_types_enum,
          title,
          message,
          role: "administrator",
          entity_id: matchId,
        });

        const shouldNotifyDiscord = await this.shouldSendDiscordNotification(
          null,
          `discord_match_notify_${newStatus}`,
        );
        if (shouldNotifyDiscord) {
          const discordMessage = `Match status changed to **${readableStatus}**. [View Match](${matchUrl})`;
          const color = STATUS_COLORS[newStatus] ?? DISCORD_COLORS.GRAY;
          await this.sendDiscordMatchNotification(
            title,
            discordMessage,
            color,
            null,
          );
        }
        return;
      }

      // Tournament case
      const tournamentContext = ` in tournament <b>${tournament.name}</b>`;
      const message = `Match status changed to <b>${readableStatus}</b>${tournamentContext}. <a href="${matchUrl}">View Match</a>`;

      const organizerSteamIds = new Set<string>();
      organizerSteamIds.add(String(tournament.organizer_steam_id));
      for (const org of tournament.organizers || []) {
        organizerSteamIds.add(String(org.steam_id));
      }

      for (const steamId of organizerSteamIds) {
        await this.insertNotification({
          type: "MatchStatusChange" as e_notification_types_enum,
          title,
          message,
          steam_id: steamId,
          role: "tournament_organizer",
          entity_id: matchId,
        });
      }

      await this.insertNotification({
        type: "MatchStatusChange" as e_notification_types_enum,
        title,
        message,
        role: "administrator",
        entity_id: matchId,
      });

      const notifyKey =
        `discord_notify_${newStatus}` as keyof typeof tournament;
      const shouldNotifyDiscord = await this.shouldSendDiscordNotification(
        tournament[notifyKey] as boolean | null | undefined,
        `discord_match_notify_${newStatus}`,
      );
      if (shouldNotifyDiscord) {
        const discordTournamentContext = ` in tournament **${tournament.name}**`;
        const discordMessage = `Match status changed to **${readableStatus}**${discordTournamentContext}. [View Match](${matchUrl})`;
        const color = STATUS_COLORS[newStatus] ?? DISCORD_COLORS.GRAY;
        await this.sendDiscordMatchNotification(
          title,
          discordMessage,
          color,
          tournament,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error sending match status notification for match ${matchId}`,
        error,
      );
    }
  }

  async sendMatchMapPauseNotification(matchId: string) {
    try {
      const { tournament_brackets } = await this.hasura.query({
        tournament_brackets: {
          __args: {
            where: {
              match_id: { _eq: matchId },
            },
            limit: 1,
          },
          stage: {
            tournament: {
              id: true,
              name: true,
              organizer_steam_id: true,
              organizers: {
                steam_id: true,
              },
              discord_notifications_enabled: true,
              discord_webhook: true,
              discord_role_id: true,
              discord_notify_MapPaused: true,
            },
          },
        },
      });

      const tournament = tournament_brackets?.at(0)?.stage.tournament;

      const matchUrl = `${this.appConfig.webDomain}/matches/${matchId}`;
      const title = "Match Alert: Map Paused";

      if (!tournament) {
        const message = `A map has been paused in match <a href="${matchUrl}">View Match</a>`;

        await this.insertNotification({
          type: "MatchStatusChange" as e_notification_types_enum,
          title,
          message,
          role: "administrator",
          entity_id: matchId,
        });

        const shouldNotifyDiscord = await this.shouldSendDiscordNotification(
          null,
          "discord_match_notify_MapPaused",
        );
        if (shouldNotifyDiscord) {
          const discordMessage = `A map has been paused. [View Match](${matchUrl})`;
          await this.sendDiscordMatchNotification(
            title,
            discordMessage,
            DISCORD_COLORS.RED,
            null,
          );
        }
        return;
      }

      // Tournament case
      const tournamentContext = ` in tournament <b>${tournament.name}</b>`;
      const message = `A map has been paused${tournamentContext} in match <a href="${matchUrl}">View Match</a>`;

      const organizerSteamIds = new Set<string>();
      organizerSteamIds.add(String(tournament.organizer_steam_id));
      for (const org of tournament.organizers || []) {
        organizerSteamIds.add(String(org.steam_id));
      }

      for (const steamId of organizerSteamIds) {
        await this.insertNotification({
          type: "MatchStatusChange" as e_notification_types_enum,
          title,
          message,
          steam_id: steamId,
          role: "tournament_organizer",
          entity_id: matchId,
        });
      }

      await this.insertNotification({
        type: "MatchStatusChange" as e_notification_types_enum,
        title,
        message,
        role: "administrator",
        entity_id: matchId,
      });

      const shouldNotifyDiscord = await this.shouldSendDiscordNotification(
        tournament.discord_notify_MapPaused,
        "discord_match_notify_MapPaused",
      );
      if (shouldNotifyDiscord) {
        const discordTournamentContext = ` in tournament **${tournament.name}**`;
        const discordMessage = `A map has been paused${discordTournamentContext}. [View Match](${matchUrl})`;
        await this.sendDiscordMatchNotification(
          title,
          discordMessage,
          DISCORD_COLORS.RED,
          tournament,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error sending match map pause notification for match ${matchId}`,
        error,
      );
    }
  }

  private async insertNotification(notification: {
    type: e_notification_types_enum;
    title: string;
    message: string;
    entity_id?: string;
    role: e_player_roles_enum;
    steam_id?: string;
  }) {
    await this.hasura.mutation({
      insert_notifications_one: {
        __args: {
          object: notification,
        },
        id: true,
      },
    });
  }

  private async shouldSendDiscordNotification(
    tournamentOverride: boolean | null | undefined,
    globalSettingName: string,
  ): Promise<boolean> {
    if (tournamentOverride !== null && tournamentOverride !== undefined) {
      return tournamentOverride;
    }

    const { settings_by_pk: setting } = await this.hasura.query({
      settings_by_pk: {
        __args: { name: globalSettingName },
        value: true,
      },
    });
    return setting?.value === "true";
  }

  private isValidDiscordWebhookUrl(url: string): boolean {
    return /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/.+$/.test(
      url,
    );
  }

  private formatRoleMentions(
    roleIds: string | null | undefined,
  ): string | undefined {
    if (!roleIds) return undefined;
    const mentions = roleIds
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id)
      .map((id) => `<@&${id}>`);
    return mentions.length > 0 ? mentions.join(" ") : undefined;
  }

  private async sendDiscordMatchNotification(
    title: string,
    message: string,
    color: number,
    tournament?: Pick<
      tournaments,
      "discord_webhook" | "discord_role_id" | "discord_notifications_enabled"
    > | null,
  ) {
    if (tournament?.discord_notifications_enabled === false) {
      return;
    }

    // Resolve webhook URL: tournament override > global match webhook > global support webhook
    let webhookUrl = tournament?.discord_webhook || null;

    if (!webhookUrl) {
      const { settings_by_pk: matchWebhookSetting } = await this.hasura.query({
        settings_by_pk: {
          __args: {
            name: "discord_match_notifications_webhook",
          },
          value: true,
        },
      });
      webhookUrl = matchWebhookSetting?.value;
    }

    if (!webhookUrl) {
      const { settings_by_pk: fallbackWebhook } = await this.hasura.query({
        settings_by_pk: {
          __args: {
            name: "discord_support_webhook",
          },
          value: true,
        },
      });
      webhookUrl = fallbackWebhook?.value;
    }

    if (!webhookUrl) {
      return;
    }

    if (!this.isValidDiscordWebhookUrl(webhookUrl)) {
      this.logger.warn(`Invalid Discord webhook URL, skipping notification`);
      return;
    }

    // Resolve role ID: tournament override > global match role ID
    let roleId = tournament?.discord_role_id || null;

    if (!roleId) {
      const { settings_by_pk: roleIdSetting } = await this.hasura.query({
        settings_by_pk: {
          __args: {
            name: "discord_match_notifications_role_id",
          },
          value: true,
        },
      });
      roleId = roleIdSetting?.value;
    }

    const content = this.formatRoleMentions(roleId);

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...(content && { content }),
          embeds: [{ title, description: message, color }],
          username: "5stack",
        }),
      });
    } catch (error) {
      this.logger.error("Error sending discord match notification", error);
    }
  }
}
