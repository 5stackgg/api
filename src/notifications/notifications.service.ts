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
import { NotificationPreferencesService } from "./preferences/notification-preferences.service";
import { PushNotificationsService } from "./push/push-notifications.service";
import { inAppKeyForType } from "./preferences/notification-categories";

@Injectable()
export class NotificationsService {
  private readonly appConfig: AppConfig;

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
    // Relaying every chat line to a Discord webhook would be unusable, and
    // the people in the lobby are already the ones being notified.
    "ChatMessage",
  ]);

  // Nobody has seen a notification in six months who hasn't signed in, and a
  // broadcast to every player row would include shadow rows created by match
  // imports.
  private static readonly ACTIVE_PLAYER_WINDOW = "30 days";

  constructor(
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
    private readonly configService: ConfigService,
    private readonly preferences: NotificationPreferencesService,
    private readonly pushNotifications: PushNotificationsService,
    @InjectQueue(NotificationsQueues.SanctionNotifications)
    private readonly sanctionNotificationsQueue: Queue,
    @InjectQueue(NotificationsQueues.PushBroadcast)
    private readonly pushBroadcastQueue: Queue,
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

  // Hasura's event trigger fires once per inserted row, so a fan-out that wrote
  // 200 rows would resolve recipients and send 200 times over. The rows are
  // claimed here so those events fall through, and one job covers the burst.
  //
  // A single row is left to its own event: it is one query either way, and the
  // claim would only add a round trip.
  private async pushFanOut(
    ids: string[],
    window?: { type: string; entityId: string },
  ) {
    if (ids.length < 2) {
      return;
    }

    try {
      // Queued before the rows are claimed, deliberately. Claiming first and
      // then failing to queue would silence the push entirely; this order fails
      // the other way, into a duplicate the device collapses on its tag.
      await this.pushBroadcastQueue.add(
        "PushBroadcast",
        window ?? { ids },
        {
          ...(window
            ? { jobId: `push-broadcast.${window.type}.${window.entityId}` }
            : {}),
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 3600 },
        },
      );

      await this.pushNotifications.claimFanOut(ids);
    } catch (error) {
      // The per-row events are still queued behind this, so a failure here
      // degrades to the unbatched path rather than losing the push.
      this.logger.warn("unable to batch push for a fan-out notification", error);
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
    // Filtered before the insert rather than at read time: the bell reads
    // `notifications` straight through Hasura, and "hide rows whose type the
    // viewer muted" isn't expressible as a select_permission.
    const steamIds = await this.preferences.filterInAppRecipients(
      type,
      Array.from(new Set(notification.steamIds)),
    );

    if (steamIds.length > 0) {
      const { insert_notifications } = await this.hasura.mutation({
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
          returning: {
            id: true,
          },
        },
      });

      await this.pushFanOut(
        (insert_notifications?.returning ?? []).map(({ id }) => id as string),
      );
    }

    const webhook = await this.getSettingValue("discord_support_webhook");
    if (webhook && !NotificationsService.IN_APP_ONLY_TYPES.has(type)) {
      await this.postDiscord(webhook, undefined, {
        title: notification.title,
        message: notification.message,
        color,
      });
    }
  }

  // Retracts alerts that describe a condition rather than an event.
  //
  // "Map is paused" and "waiting for a server" are true only while they are
  // true -- once the match resumes, ends or is cancelled they describe nothing.
  // Left alone they pile up: a month of pauses on one match produced over a
  // hundred rows nobody could act on.
  //
  // Cleared rather than collapsed, deliberately. Collapsing keeps one stale
  // alert per match forever; clearing leaves the bell holding only conditions
  // that currently hold.
  async resolveMatchAlerts(matchId: string) {
    await this.postgres.query(
      `UPDATE public.notifications
          SET deleted_at = now()
        WHERE type = 'MatchStatusChange'
          AND entity_id = $1
          AND deleted_at IS NULL`,
      [matchId],
    );
  }

  // Soft-deletes every unread row for an entity except the newest, so a busy
  // conversation shows one bell entry rather than one per message. Push is
  // unaffected -- each message already fired its own INSERT.
  async collapseOlderUnread(
    type: e_notification_types_enum,
    entityId: string,
    steamIds: string[],
  ) {
    if (steamIds.length === 0) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.notifications n
          SET deleted_at = now()
        WHERE n.type = $1
          AND n.entity_id = $2
          AND n.steam_id = ANY($3::bigint[])
          AND n.is_read = false
          AND n.deleted_at IS NULL
          AND n.id <> (
            SELECT newest.id
              FROM public.notifications newest
             WHERE newest.type = n.type
               AND newest.entity_id = n.entity_id
               AND newest.steam_id = n.steam_id
               AND newest.deleted_at IS NULL
             ORDER BY newest.created_at DESC
             LIMIT 1
          )`,
      [type, entityId, steamIds],
    );
  }

  // Opening a conversation should clear its badge everywhere, not just in the
  // tab that was open.
  async markConversationRead(
    type: e_notification_types_enum,
    entityId: string,
    steamId: string,
  ) {
    await this.postgres.query(
      `UPDATE public.notifications
          SET is_read = true
        WHERE type = $1
          AND entity_id = $2
          AND steam_id = $3::bigint
          AND is_read = false`,
      [type, entityId, steamId],
    );
  }

  // Announce something to the whole player base.
  //
  // This deliberately writes one row per player rather than a single
  // role-targeted row: our notifications select_permissions are a per-role
  // enumeration, and `user` only ever matches on steam_id -- so a
  // `role: 'user'` broadcast with a null steam_id is visible to nobody.
  //
  // Written as one INSERT..SELECT because the recipient list is the whole
  // players table, and the in-app preference filter is inlined for the same
  // reason.
  async notifyActivePlayers(
    type: e_notification_types_enum,
    notification: {
      title: string;
      message: string;
      entity_id?: string;
    },
  ) {
    const key = inAppKeyForType(type);

    const inserted = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.notifications (type, title, message, role, steam_id, entity_id)
            SELECT $1, $2, $3, 'user', p.steam_id, $4
              FROM public.players p
         LEFT JOIN public.notification_preferences np
                ON np.steam_id = p.steam_id
               AND np.channel = 'in_app'
               AND np.key = $5
             WHERE p.last_sign_in_at >= now() - $6::interval
               AND COALESCE(np.enabled, $7::boolean) = true
         RETURNING id::text AS id`,
      [
        type,
        notification.title,
        notification.message,
        notification.entity_id ?? null,
        key?.key ?? "",
        NotificationsService.ACTIVE_PLAYER_WINDOW,
        key?.defaultEnabled ?? true,
      ],
    );

    // The recipient list here is the whole player base, so the ids are claimed
    // but not carried in the job: sendForBatch resolves them from
    // (type, entity_id) in one statement rather than shipping a payload with a
    // row per player in it.
    if (notification.entity_id) {
      await this.pushFanOut(
        inserted.map(({ id }) => id),
        { type, entityId: notification.entity_id },
      );
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
