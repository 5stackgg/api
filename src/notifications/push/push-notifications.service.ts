import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as webPush from "web-push";
import { PostgresService } from "../../postgres/postgres.service";
import { AppConfig } from "src/configs/types/AppConfig";
import { WebPushConfig } from "src/configs/types/WebPushConfig";
import { e_player_roles_enum } from "generated/schema";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { pushCategoryForType } from "../preferences/notification-categories";
import { stripHtml } from "../utilities/stripHtml";
import { notificationUrl } from "../utilities/notificationUrl";
import { isAllowedPushEndpoint } from "./push-endpoint";

export type PushSubscriptionPayload = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type NotificationRow = {
  id: string;
  type: string;
  role: e_player_roles_enum;
  title: string;
  message: string;
  entity_id?: string | null;
};

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// Which roles can actually see a role-broadcast notification, mirroring the
// select_permissions in
// hasura/metadata/databases/default/tables/public_notifications.yaml.
//
// This is deliberately NOT isRoleAbove(). Our notification permissions are a
// hand-written per-role enumeration rather than a hierarchy -- an administrator
// does not see a tournament_organizer broadcast today -- and pushing something
// the player cannot then open in the bell is worse than not pushing at all.
// Any role absent here (notably `user`) sees no broadcasts at all, so a
// role-targeted row with no steam_id reaches nobody.
//
// Keep in lockstep with that yaml.
const RECIPIENT_ROLES: Record<string, e_player_roles_enum[]> = {
  administrator: ["administrator"],
  tournament_organizer: ["tournament_organizer"],
  match_organizer: ["match_organizer", "tournament_organizer"],
};

// Types that fan out to one row per player. The trigger fires per row, so for
// these the handler collapses into a single deduped job instead of doing a
// query and a send for each of thousands of inserts.
const BATCHED_TYPES = new Set<string>(["TournamentCreated", "NewsPublished"]);

const SEND_CHUNK_SIZE = 25;

@Injectable()
export class PushNotificationsService {
  private readonly appConfig: AppConfig;
  private readonly webPushConfig: WebPushConfig;
  private publicKey: string | null = null;
  private configured = false;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
    this.webPushConfig = this.configService.get<WebPushConfig>("webPush");
  }

  // Keys live in `settings` so an operator can generate them from the panel --
  // VAPID is a self-signed keypair, not a vendor credential, so there is
  // nothing to register and no reason to force an env var. Env still wins when
  // set, for anyone who would rather manage secrets outside the database.
  public async loadKeys(): Promise<void> {
    const publicKey =
      this.webPushConfig?.publicKey ||
      (await this.getSetting(SystemSettingName.WebPushPublicKey));
    const privateKey =
      this.webPushConfig?.privateKey ||
      (await this.getSetting(SystemSettingName.WebPushPrivateKey));

    if (publicKey && privateKey) {
      this.apply(publicKey, privateKey);
      return;
    }

    // Nothing configured. The panel generates a keypair into api-secrets on
    // install, but an install that predates that -- or one deployed without the
    // panel -- would otherwise sit here permanently disabled. VAPID keys are
    // self-signed with nothing to register, so there is no reason to make an
    // operator go and fetch one.
    this.logger.log("no VAPID keys found; generating a keypair");

    try {
      const keys = webPush.generateVAPIDKeys();

      await this.setSetting(SystemSettingName.WebPushPublicKey, keys.publicKey);
      await this.setSetting(
        SystemSettingName.WebPushPrivateKey,
        keys.privateKey,
      );

      this.apply(keys.publicKey, keys.privateKey);
    } catch (error) {
      this.configured = false;
      this.publicKey = null;
      this.logger.warn(
        "unable to generate VAPID keys; web push notifications are disabled",
        error,
      );
    }
  }

  private apply(publicKey: string, privateKey: string) {
    webPush.setVapidDetails(this.webPushConfig.subject, publicKey, privateKey);
    this.configured = true;
    this.publicKey = publicKey;
  }

  // Generates a fresh keypair and stores it.
  //
  // Rotating invalidates every existing subscription -- the browser signed up
  // against the old public key and the push service will reject sends signed by
  // the new one -- so the stale rows are cleared out rather than left to fail
  // one 403 at a time.
  public async generateKeys(): Promise<{ publicKey: string }> {
    if (this.webPushConfig?.publicKey || this.webPushConfig?.privateKey) {
      throw new Error(
        "web push keys are set through the environment; unset WEB_PUSH_PUBLIC_KEY/WEB_PUSH_PRIVATE_KEY to manage them here",
      );
    }

    const keys = webPush.generateVAPIDKeys();

    await this.setSetting(SystemSettingName.WebPushPublicKey, keys.publicKey);
    await this.setSetting(SystemSettingName.WebPushPrivateKey, keys.privateKey);
    await this.postgres.query(`DELETE FROM public.push_subscriptions`);

    await this.loadKeys();

    return { publicKey: keys.publicKey };
  }

  public async countSubscriptions(): Promise<[number]> {
    const [row] = await this.postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM public.push_subscriptions`,
    );

    return [Number(row?.count ?? 0)];
  }

  private async getSetting(name: string): Promise<string | undefined> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [name],
    );

    return row?.value || undefined;
  }

  private async setSetting(name: string, value: string): Promise<void> {
    await this.postgres.query(
      `INSERT INTO public.settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [name, value],
    );
  }

  public isConfigured(): boolean {
    return this.configured;
  }

  public isManagedByEnvironment(): boolean {
    return Boolean(
      this.webPushConfig?.publicKey || this.webPushConfig?.privateKey,
    );
  }

  public getPublicKey(): string | null {
    return this.publicKey;
  }

  public static isBatched(type: string): boolean {
    return BATCHED_TYPES.has(type);
  }

  public async subscribe(
    steamId: string,
    subscription: PushSubscriptionPayload,
    userAgent?: string,
  ): Promise<void> {
    // The endpoint is a URL this server will POST to later, supplied by the
    // client. See push-endpoint.ts for why this is an allowlist.
    if (!isAllowedPushEndpoint(subscription?.endpoint)) {
      this.logger.warn(
        `rejected push subscription for an untrusted endpoint (steam_id ${steamId})`,
      );
      throw new BadRequestException("invalid push subscription endpoint");
    }

    if (!subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      throw new BadRequestException("invalid push subscription keys");
    }

    await this.postgres.query(
      `INSERT INTO public.push_subscriptions (steam_id, endpoint, p256dh, auth, user_agent)
            VALUES ($1::bigint, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
               SET steam_id = EXCLUDED.steam_id,
                   p256dh = EXCLUDED.p256dh,
                   auth = EXCLUDED.auth,
                   user_agent = EXCLUDED.user_agent,
                   last_used_at = now()`,
      [
        steamId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        userAgent?.slice(0, 512) ?? null,
      ],
    );
  }

  public async unsubscribe(steamId: string, endpoint: string): Promise<void> {
    await this.postgres.query(
      `DELETE FROM public.push_subscriptions
             WHERE endpoint = $1 AND steam_id = $2::bigint`,
      [endpoint, steamId],
    );
  }

  // Resolves recipients, role visibility and push preferences in one indexed
  // statement. Note it joins back to `notifications` by id rather than reading
  // steam_id from the event payload: Hasura builds that payload with
  // row_to_json, and JSON.parse rounds anything past 2^53 -- which every steam
  // id is, by about eight times.
  public async sendForNotification(
    notification: Pick<NotificationRow, "id" | "type">,
  ): Promise<void> {
    if (!this.configured) {
      return;
    }

    const [row] = await this.postgres.query<NotificationRow[]>(
      `SELECT id::text AS id, type::text AS type, role::text AS role,
              title, message, entity_id
         FROM public.notifications
        WHERE id = $1::uuid`,
      [notification.id],
    );

    if (!row) {
      return;
    }

    const category = pushCategoryForType(row.type);

    if (!category) {
      // Fail open: a type nobody has categorised yet still gets delivered.
      // notification-categories.spec.ts is what stops this happening.
      this.logger.warn(`no push category for notification type ${row.type}`);
    }

    const subscriptions = await this.postgres.query<SubscriptionRow[]>(
      `SELECT ps.id::text AS id, ps.endpoint, ps.p256dh, ps.auth
         FROM public.notifications n
         JOIN public.players p
           ON (n.steam_id IS NOT NULL AND p.steam_id = n.steam_id)
           OR (n.steam_id IS NULL AND p.role::text = ANY($2::text[]))
         JOIN public.push_subscriptions ps ON ps.steam_id = p.steam_id
    LEFT JOIN public.notification_preferences np
           ON np.steam_id = p.steam_id
          AND np.channel = 'push'
          AND np.key = $3
        WHERE n.id = $1::uuid
          AND COALESCE(np.enabled, $4::boolean) = true
          -- Push only. The bell row is already written either way, so a quiet
          -- window silences the buzz without losing the notification.
          AND NOT public.is_quiet_hours(
                p.quiet_hours_start, p.quiet_hours_end, p.notification_timezone)`,
      [
        row.id,
        RECIPIENT_ROLES[row.role] ?? [],
        category?.key ?? "",
        category?.defaultEnabled ?? true,
      ],
    );

    await this.deliver(subscriptions, row);
  }

  // The batched counterpart: one job per (type, entity_id) resolves every row
  // that fan-out just inserted, rather than one query and send per row.
  public async sendForBatch(type: string, entityId: string): Promise<void> {
    if (!this.configured) {
      return;
    }

    const [row] = await this.postgres.query<NotificationRow[]>(
      `SELECT id::text AS id, type::text AS type, role::text AS role,
              title, message, entity_id
         FROM public.notifications
        WHERE type = $1 AND entity_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [type, entityId],
    );

    if (!row) {
      return;
    }

    const category = pushCategoryForType(type);

    const subscriptions = await this.postgres.query<SubscriptionRow[]>(
      `SELECT DISTINCT ps.id::text AS id, ps.endpoint, ps.p256dh, ps.auth
         FROM public.notifications n
         JOIN public.push_subscriptions ps ON ps.steam_id = n.steam_id
         JOIN public.players p ON p.steam_id = n.steam_id
    LEFT JOIN public.notification_preferences np
           ON np.steam_id = n.steam_id
          AND np.channel = 'push'
          AND np.key = $3
        WHERE n.type = $1
          AND n.entity_id = $2
          AND n.created_at > now() - interval '15 minutes'
          AND COALESCE(np.enabled, $4::boolean) = true
          AND NOT public.is_quiet_hours(
                p.quiet_hours_start, p.quiet_hours_end, p.notification_timezone)`,
      [type, entityId, category?.key ?? "", category?.defaultEnabled ?? true],
    );

    await this.deliver(subscriptions, row);
  }

  private async deliver(
    subscriptions: SubscriptionRow[],
    notification: NotificationRow,
  ): Promise<void> {
    if (subscriptions.length === 0) {
      return;
    }

    const payload = JSON.stringify({
      title: notification.title,
      body: stripHtml(notification.message),
      url: notificationUrl(notification, this.appConfig.webDomain),
      // Lets a device collapse repeats of the same conversation or match
      // rather than stacking a separate notification for each.
      tag: `${notification.type}:${notification.entity_id ?? notification.id}`,
    });

    const delivered: string[] = [];
    const expired: string[] = [];

    for (let i = 0; i < subscriptions.length; i += SEND_CHUNK_SIZE) {
      const chunk = subscriptions.slice(i, i + SEND_CHUNK_SIZE);

      await Promise.all(
        chunk.map(async (subscription) => {
          // Checked again on the way out, not just on the way in: rows stored
          // before the subscribe-time check existed would otherwise still be
          // POSTed to. Dropped rather than skipped, so it self-heals.
          if (!isAllowedPushEndpoint(subscription.endpoint)) {
            this.logger.warn(
              `dropping push subscription ${subscription.id} with an untrusted endpoint`,
            );
            expired.push(subscription.id);
            return;
          }

          try {
            await webPush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: {
                  p256dh: subscription.p256dh,
                  auth: subscription.auth,
                },
              },
              payload,
            );
            delivered.push(subscription.id);
          } catch (error) {
            const statusCode = (error as { statusCode?: number })?.statusCode;

            // The push service itself saying this subscription is gone --
            // uninstalled PWA, cleared site data. Anything else might be
            // transient, so the row stays.
            if (statusCode === 404 || statusCode === 410) {
              expired.push(subscription.id);
              return;
            }

            this.logger.warn(
              `unable to push notification to subscription ${subscription.id}`,
              error,
            );
          }
        }),
      );
    }

    if (delivered.length > 0) {
      await this.postgres
        .query(
          `UPDATE public.push_subscriptions SET last_used_at = now()
                 WHERE id = ANY($1::uuid[])`,
          [delivered],
        )
        .catch((error) => {
          this.logger.warn("unable to update push subscription rows", error);
        });
    }

    if (expired.length > 0) {
      await this.postgres
        .query(
          `DELETE FROM public.push_subscriptions WHERE id = ANY($1::uuid[])`,
          [expired],
        )
        .catch((error) => {
          this.logger.warn("unable to update push subscription rows", error);
        });
    }
  }
}
