import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as webPush from "web-push";
import Redis from "ioredis";
import { PostgresService } from "../../postgres/postgres.service";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
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

export type SubscriptionStats = {
  subscriptions: number;
  players: number;
  active_7d: number;
  new_7d: number;
  never_delivered: number;
  last_delivered_at: string | null;
  platforms: Array<{ platform: string; devices: number }>;
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

const fanOutClaimKey = (id: string) => `notifications:fan-out:${id}`;

// Long enough to outlast Hasura's delivery of the last row in a fan-out,
// including its retry_conf (3 retries, 10s apart, 60s timeout each).
const FAN_OUT_CLAIM_TTL_SECONDS = 900;

@Injectable()
export class PushNotificationsService {
  private readonly appConfig: AppConfig;
  private readonly webPushConfig: WebPushConfig;
  private readonly redis: Redis;
  private publicKey: string | null = null;
  private configured = false;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly configService: ConfigService,
    redisManager: RedisManagerService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
    this.webPushConfig = this.configService.get<WebPushConfig>("webPush");
    this.redis = redisManager.getConnection();
  }

  // A fan-out writes one notification row per recipient and Hasura's event
  // trigger fires for every one of them, so the naive path costs two queries
  // and a send per row. The writer claims the rows it just inserted and pushes
  // them in a single pass instead; the per-row events then cost one set lookup.
  //
  // Claimed by id rather than by (type, entity_id) so a later single-recipient
  // notification for the same conversation is never swallowed by a stale claim.
  public async claimFanOut(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();

    for (const id of ids) {
      pipeline.set(fanOutClaimKey(id), 1, "EX", FAN_OUT_CLAIM_TTL_SECONDS);
    }

    await pipeline.exec();
  }

  public async isFanOutClaimed(id: string): Promise<boolean> {
    return (await this.redis.exists(fanOutClaimKey(id))) === 1;
  }

  // Keys live in `settings` and are generated on first boot -- VAPID is a
  // self-signed keypair, not a vendor credential, so there is nothing to
  // register and no reason to force an env var or to expose rotation. Env still
  // wins when set, for anyone who would rather manage secrets outside the
  // database.
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
      const claimed = await this.claimKeys(webPush.generateVAPIDKeys());

      this.apply(claimed.publicKey, claimed.privateKey);
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


  // Which of these players could receive a push at all. Callers use it to
  // decide whether a recipient who muted the bell still needs a notifications
  // row written for them -- the INSERT event trigger is what delivers push, so
  // no row means no push, but a row nobody can be pushed to is dead weight.
  public async filterSubscribed(steamIds: string[]): Promise<string[]> {
    if (!this.configured || steamIds.length === 0) {
      return [];
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT steam_id::text AS steam_id
         FROM public.push_subscriptions
        WHERE steam_id = ANY($1::bigint[])`,
      [steamIds],
    );

    return rows.map((row) => row.steam_id);
  }

  // Everything the admin status page shows, derived from push_subscriptions --
  // no counters to keep in sync, and `last_used_at` is already stamped on every
  // successful send, which makes it the only real proof that delivery works
  // end to end rather than just that a keypair exists.
  public async getSubscriptionStats(): Promise<SubscriptionStats> {
    const [totals] = await this.postgres.query<
      Array<{
        devices: string;
        players: string;
        active_7d: string;
        new_7d: string;
        never_delivered: string;
        last_delivered_at: Date | null;
      }>
    >(
      `SELECT count(*)::text AS devices,
              count(DISTINCT steam_id)::text AS players,
              (count(*) FILTER (
                 WHERE last_used_at > now() - interval '7 days'))::text AS active_7d,
              (count(*) FILTER (
                 WHERE created_at > now() - interval '7 days'))::text AS new_7d,
              (count(*) FILTER (WHERE last_used_at IS NULL))::text AS never_delivered,
              max(last_used_at) AS last_delivered_at
         FROM public.push_subscriptions`,
    );

    // The push service is the only platform signal that can be trusted --
    // user_agent is whatever the browser felt like sending, but the endpoint
    // host is enforced by the table's CHECK constraint.
    const platforms = await this.postgres.query<
      Array<{ platform: string; devices: string }>
    >(
      `SELECT CASE
                WHEN endpoint ~* 'push\\.apple\\.com' THEN 'apple'
                WHEN endpoint ~* '(fcm|android)\\.googleapis\\.com' THEN 'google'
                WHEN endpoint ~* 'push\\.services\\.mozilla\\.com' THEN 'mozilla'
                WHEN endpoint ~* 'notify\\.windows\\.com' THEN 'windows'
                ELSE 'other'
              END AS platform,
              count(*)::text AS devices
         FROM public.push_subscriptions
        GROUP BY 1
        ORDER BY count(*) DESC`,
    );

    return {
      subscriptions: Number(totals?.devices ?? 0),
      players: Number(totals?.players ?? 0),
      active_7d: Number(totals?.active_7d ?? 0),
      new_7d: Number(totals?.new_7d ?? 0),
      never_delivered: Number(totals?.never_delivered ?? 0),
      last_delivered_at: totals?.last_delivered_at
        ? new Date(totals.last_delivered_at).toISOString()
        : null,
      platforms: platforms.map((row) => ({
        platform: row.platform,
        devices: Number(row.devices),
      })),
    };
  }

  private async getSetting(name: string): Promise<string | undefined> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [name],
    );

    return row?.value || undefined;
  }

  // The install-time write, and the only one there is -- keys are never
  // rotated. The first pod to get here wins and every other pod adopts what is
  // already stored. Overwriting instead would leave pods signing with different
  // private keys, and every subscription a browser took out against the loser's
  // public key rejected with a 403 until that pod restarted.
  //
  // Both rows go in one statement so a race cannot leave two halves of
  // different keypairs behind, and the read is a second statement because a
  // CTE's SELECT runs against the snapshot from before its own INSERT.
  private async claimKeys(keys: {
    publicKey: string;
    privateKey: string;
  }): Promise<{ publicKey: string; privateKey: string }> {
    const names = [
      SystemSettingName.WebPushPublicKey,
      SystemSettingName.WebPushPrivateKey,
    ];

    await this.postgres.query(
      `INSERT INTO public.settings (name, value)
            VALUES ($1, $2), ($3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [names[0], keys.publicKey, names[1], keys.privateKey],
    );

    const rows = await this.postgres.query<
      Array<{ name: string; value: string }>
    >(`SELECT name, value FROM public.settings WHERE name = ANY($1::text[])`, [
      names,
    ]);

    const stored = new Map(rows.map((row) => [row.name, row.value]));
    const publicKey = stored.get(names[0]);
    const privateKey = stored.get(names[1]);

    if (!publicKey || !privateKey) {
      throw new Error("VAPID keys were not stored");
    }

    return { publicKey, privateKey };
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

  // The counterpart for a fan-out whose recipients are known: one pass over the
  // exact rows the insert produced. Preferred over sendForBatch wherever the
  // ids are to hand — it carries no time window, so it can never pick up a row
  // from an earlier message and push someone their own words back at them.
  public async sendForIds(ids: string[]): Promise<void> {
    if (!this.configured || ids.length === 0) {
      return;
    }

    const [row] = await this.postgres.query<NotificationRow[]>(
      `SELECT id::text AS id, type::text AS type, role::text AS role,
              title, message, entity_id
         FROM public.notifications
        WHERE id = ANY($1::uuid[])
        ORDER BY created_at DESC
        LIMIT 1`,
      [ids],
    );

    if (!row) {
      return;
    }

    const category = pushCategoryForType(row.type);

    const subscriptions = await this.postgres.query<SubscriptionRow[]>(
      `SELECT DISTINCT ps.id::text AS id, ps.endpoint, ps.p256dh, ps.auth
         FROM public.notifications n
         JOIN public.players p ON p.steam_id = n.steam_id
         JOIN public.push_subscriptions ps ON ps.steam_id = n.steam_id
    LEFT JOIN public.notification_preferences np
           ON np.steam_id = n.steam_id
          AND np.channel = 'push'
          AND np.key = $2
        WHERE n.id = ANY($1::uuid[])
          AND COALESCE(np.enabled, $3::boolean) = true
          AND NOT public.is_quiet_hours(
                p.quiet_hours_start, p.quiet_hours_end, p.notification_timezone)`,
      [ids, category?.key ?? "", category?.defaultEnabled ?? true],
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
