import TurndownService from "turndown";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { AppConfig } from "src/configs/types/AppConfig";
import {
  e_notification_types_enum,
  e_player_roles_enum,
  tournaments,
} from "generated/schema";
import { DISCORD_COLORS } from "./utilities/constants";
import { NotificationsQueues } from "./enums/NotificationsQueues";

@Injectable()
export class NotificationsService {
  private readonly appConfig: AppConfig;

  // Notification types that should only ever appear in-app (never Discord).
  static readonly IN_APP_ONLY_TYPES = new Set<string>([
    "ScrimRequestReceived",
    "ScrimRequestCountered",
    "ScrimRequestAccepted",
    "ScrimRequestDeclined",
    "ScrimRequestExpired",
    "ScrimMatchScheduled",
    "ScrimMatchCanceled",
    "ScrimTimeChanged",
    "ScrimAlertMatch",
    "FormTeamSuggestion",
  ]);

  constructor(
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
    private readonly configService: ConfigService,
    @InjectQueue(NotificationsQueues.SanctionNotifications)
    private readonly sanctionNotificationsQueue: Queue,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  async queueSanctionNotification(sanction: {
    sanctionId: string;
    steamId: string;
    type: string;
    reason?: string | null;
  }): Promise<void> {
    await this.sanctionNotificationsQueue.add(
      "SendSanctionNotifications",
      sanction,
      {
        jobId: `sanction-notify.${sanction.sanctionId}`,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 3600 },
      },
    );
  }

  public static escapeHtml(value: string | null | undefined): string {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private static readonly SANCTION_VERBS: Record<string, string> = {
    ban: "banned",
    mute: "muted",
    gag: "gagged",
    silence: "silenced",
  };

  async notifyMatchPlayersOfSanction(sanction: {
    sanctionId: string;
    steamId: string;
    type: string;
    reason?: string | null;
  }): Promise<void> {
    const recipients = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT other_p.steam_id::text AS steam_id
         FROM public.matches m
         JOIN public.match_lineup_players self_p
           ON self_p.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
          AND self_p.steam_id = $1::bigint
         JOIN public.match_lineup_players other_p
           ON other_p.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
          AND other_p.steam_id IS NOT NULL
          AND other_p.steam_id <> $1::bigint
        WHERE m.created_at >= now() - interval '6 months'
          AND m.status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')`,
      [sanction.steamId],
    );

    if (recipients.length === 0) {
      return;
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: sanction.steamId },
        name: true,
      },
    });
    const name = players_by_pk?.name ?? `Player ${sanction.steamId}`;

    const verb = NotificationsService.SANCTION_VERBS[sanction.type] ?? "sanctioned";
    const safeName = NotificationsService.escapeHtml(name);
    const profileUrl = `${this.appConfig.webDomain}/players/${encodeURIComponent(
      sanction.steamId,
    )}`;
    const reasonSuffix =
      sanction.type === "ban" && sanction.reason
        ? ` (${NotificationsService.escapeHtml(sanction.reason)})`
        : "";
    const message =
      `A player you recently played with, ` +
      `<a href="${profileUrl}">${safeName}</a>, was ${verb}.${reasonSuffix}`;

    await this.hasura.mutation({
      insert_notifications: {
        __args: {
          objects: recipients.map(({ steam_id }) => ({
            type: "PlayerSanctioned" as e_notification_types_enum,
            title: "Player Sanctioned",
            message,
            role: "user" as e_player_roles_enum,
            steam_id,
            entity_id: sanction.steamId,
          })),
        },
        affected_rows: true,
      },
    });

    this.logger.log(
      `notified ${recipients.length} co-player(s) of sanction (${sanction.type}) on ${sanction.steamId}`,
    );
  }

  async notifyAdminsOfBan(sanction: {
    sanctionId: string;
    steamId: string;
    type: string;
    reason?: string | null;
  }): Promise<void> {
    if (sanction.type !== "ban") {
      return;
    }

    const played = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM public.match_lineup_players
          WHERE steam_id = $1::bigint
       ) AS exists`,
      [sanction.steamId],
    );
    if (!played.at(0)?.exists) {
      return;
    }

    const reasonSuffix = sanction.reason
      ? ` (${NotificationsService.escapeHtml(sanction.reason)})`
      : "";

    await this.hasura.mutation({
      insert_notifications: {
        __args: {
          objects: [
            {
              type: "PlayerSanctioned" as e_notification_types_enum,
              title: "Player Banned",
              message: `A player has been banned.${reasonSuffix}`,
              role: "administrator" as e_player_roles_enum,
              entity_id: sanction.steamId,
            },
          ],
        },
        affected_rows: true,
      },
    });

    this.logger.log(`notified admins of ban on ${sanction.steamId}`);
  }

  async notifyBannedPlayer(sanction: {
    sanctionId: string;
    steamId: string;
    type: string;
    reason?: string | null;
  }): Promise<void> {
    if (sanction.type !== "ban") {
      return;
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: sanction.steamId },
        last_sign_in_at: true,
      },
    });
    if (!players_by_pk?.last_sign_in_at) {
      return;
    }

    const reasonSuffix = sanction.reason
      ? ` Reason: ${NotificationsService.escapeHtml(sanction.reason)}`
      : "";

    await this.hasura.mutation({
      insert_notifications: {
        __args: {
          objects: [
            {
              type: "PlayerSanctioned" as e_notification_types_enum,
              title: "You have been banned",
              message: `You have been banned from this platform.${reasonSuffix}`,
              role: "user" as e_player_roles_enum,
              steam_id: sanction.steamId,
              entity_id: sanction.steamId,
            },
          ],
        },
        affected_rows: true,
      },
    });

    this.logger.log(`notified banned player ${sanction.steamId}`);
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
    deletable?: boolean,
    routing?: {
      webhook?: string;
      role?: string;
    },
  ) {
    const webhookSetting = routing?.webhook ?? "discord_support_webhook";
    const roleSetting = routing?.role ?? "discord_support_role_id";

    let webhook = await this.getSettingValue(webhookSetting);
    if (!webhook && webhookSetting !== "discord_support_webhook") {
      webhook = await this.getSettingValue("discord_support_webhook");
    }

    let roleId = await this.getSettingValue(roleSetting);
    if (!roleId && roleSetting !== "discord_support_role_id") {
      roleId = await this.getSettingValue("discord_support_role_id");
    }

    await this.hasura.mutation({
      insert_notifications_one: {
        __args: {
          object: {
            type,
            ...notification,
            actions,
            ...(deletable === false ? { deletable: false } : {}),
          },
        },
        id: true,
      },
    });

    if (webhook) {
      await this.postDiscord(webhook, roleId, {
        title: notification.title,
        message: notification.message,
        color,
      });
    }
  }

  private async postDiscord(
    webhook: string,
    roleId: string | undefined,
    notification: {
      title: string;
      message: string;
      color?: number;
    },
  ) {
    try {
      const description = new TurndownService().turndown(notification.message);
      const content = roleId ? `<@&${roleId}>` : undefined;

      await fetch(webhook, {
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
              color: notification.color ?? DISCORD_COLORS.GRAY,
            },
          ],
          username: "5stack",
        }),
      });
    } catch (error) {
      this.logger.error("Error sending discord notification", error);
    }
  }

  async notifyPlayers(
    type: e_notification_types_enum,
    notification: {
      title: string;
      message: string;
      role: e_player_roles_enum;
      entity_id?: string;
      steamIds: Array<string>;
      deletable?: boolean;
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
    const steamIds = Array.from(new Set(notification.steamIds));

    if (steamIds.length > 0) {
      await this.hasura.mutation({
        insert_notifications: {
          __args: {
            objects: steamIds.map((steam_id) => ({
              type,
              title: notification.title,
              message: notification.message,
              role: notification.role,
              steam_id,
              entity_id: notification.entity_id,
              actions,
              ...(notification.deletable === false
                ? { deletable: false }
                : {}),
            })),
          },
          affected_rows: true,
        },
      });
    }

    // Scrim finder notifications stay in-app only — no Discord pings.
    const webhook = await this.getSettingValue("discord_support_webhook");
    if (webhook && !NotificationsService.IN_APP_ONLY_TYPES.has(type)) {
      await this.postDiscord(webhook, undefined, {
        title: notification.title,
        message: notification.message,
        color,
      });
    }
  }

  private async getSettingValue(name: string): Promise<string | undefined> {
    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name,
        },
        value: true,
      },
    });
    return settings_by_pk?.value ?? undefined;
  }

  async sendMatchWaitingForServerNotification(matchId: string) {
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
              discord_notify_WaitingForServer: true,
            },
          },
        },
      });

      const tournament = tournament_brackets?.at(0)?.stage.tournament;

      const matchUrl = `${this.appConfig.webDomain}/matches/${matchId}`;
      const title = "Match Status: Waiting for Server";

      if (!tournament) {
        const message = `Match is waiting for a server. <a href="${matchUrl}">View Match</a>`;

        const { matches_by_pk } = await this.hasura.query({
          matches_by_pk: {
            __args: { id: matchId },
            organizer_steam_id: true,
          },
        });

        if (!matches_by_pk) {
          return;
        }

        if (matches_by_pk.organizer_steam_id) {
          await this.insertNotification({
            type: "MatchStatusChange",
            title,
            message,
            steam_id: matches_by_pk.organizer_steam_id,
            role: "user",
            entity_id: matchId,
          });
        }

        await this.insertNotification({
          type: "MatchStatusChange",
          title,
          message,
          role: "match_organizer",
          entity_id: matchId,
        });

        const shouldNotifyDiscord = await this.shouldSendDiscordNotification(
          null,
          "discord_match_notify_WaitingForServer",
        );
        if (shouldNotifyDiscord) {
          const discordMessage = `Match is waiting for a server. [View Match](${matchUrl})`;
          await this.sendDiscordMatchNotification(
            title,
            discordMessage,
            DISCORD_COLORS.RED,
            null,
          );
        }
        return;
      }

      const tournamentContext = ` in tournament <b>${NotificationsService.escapeHtml(tournament.name)}</b>`;
      const message = `Match is waiting for a server${tournamentContext}. <a href="${matchUrl}">View Match</a>`;

      const organizerSteamIds = new Set<string>();
      organizerSteamIds.add(String(tournament.organizer_steam_id));
      for (const org of tournament.organizers || []) {
        organizerSteamIds.add(String(org.steam_id));
      }

      for (const steamId of organizerSteamIds) {
        await this.insertNotification({
          type: "MatchStatusChange",
          title,
          message,
          steam_id: steamId,
          role: "tournament_organizer",
          entity_id: matchId,
        });
      }

      await this.insertNotification({
        type: "MatchStatusChange",
        title,
        message,
        role: "administrator",
        entity_id: matchId,
      });

      const shouldNotifyDiscord = await this.shouldSendDiscordNotification(
        tournament.discord_notify_WaitingForServer,
        "discord_match_notify_WaitingForServer",
      );
      if (shouldNotifyDiscord) {
        const discordTournamentContext = ` in tournament **${tournament.name}**`;
        const discordMessage = `Match is waiting for a server${discordTournamentContext}. [View Match](${matchUrl})`;
        await this.sendDiscordMatchNotification(
          title,
          discordMessage,
          DISCORD_COLORS.RED,
          tournament,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error sending match waiting for server notification for match ${matchId}`,
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

        const { matches_by_pk } = await this.hasura.query({
          matches_by_pk: {
            __args: { id: matchId },
            organizer_steam_id: true,
          },
        });

        if (!matches_by_pk) {
          return;
        }

        if (matches_by_pk.organizer_steam_id) {
          await this.insertNotification({
            type: "MatchStatusChange",
            title,
            message,
            steam_id: matches_by_pk.organizer_steam_id,
            role: "user",
            entity_id: matchId,
          });
        }

        await this.insertNotification({
          type: "MatchStatusChange",
          title,
          message,
          role: "match_organizer",
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
      const tournamentContext = ` in tournament <b>${NotificationsService.escapeHtml(tournament.name)}</b>`;
      const message = `A map has been paused${tournamentContext} in match <a href="${matchUrl}">View Match</a>`;

      const organizerSteamIds = new Set<string>();
      organizerSteamIds.add(String(tournament.organizer_steam_id));
      for (const org of tournament.organizers || []) {
        organizerSteamIds.add(String(org.steam_id));
      }

      for (const steamId of organizerSteamIds) {
        await this.insertNotification({
          type: "MatchStatusChange",
          title,
          message,
          steam_id: steamId,
          role: "tournament_organizer",
          entity_id: matchId,
        });
      }

      await this.insertNotification({
        type: "MatchStatusChange",
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
    deletable?: boolean;
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
      roleId =
        (await this.getSettingValue("discord_match_notifications_role_id")) ||
        (await this.getSettingValue("discord_support_role_id")) ||
        null;
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
