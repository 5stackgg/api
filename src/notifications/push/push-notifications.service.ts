import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import * as webPush from "web-push";
import Redis from "ioredis";
import { NotificationsQueues } from "../enums/NotificationsQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import { AppConfig } from "src/configs/types/AppConfig";
import { WebPushConfig } from "src/configs/types/WebPushConfig";
import { e_player_roles_enum } from "generated/schema";
import { generateMutationOp } from "../../../generated";
import { rolesAtOrAbove } from "src/utilities/isRoleAbove";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { pushCategoryForType } from "../preferences/notification-categories";
import { stripHtml } from "../utilities/stripHtml";
import { notificationUrl } from "../utilities/notificationUrl";
import { isAllowedPushEndpoint } from "./push-endpoint";
import {
  DEFAULT_DELIVERY_POLICY,
  DeliveryPolicy,
  deliveryPolicyForType,
  presenceFocusKey,
  threadKeyFor,
} from "./notification-delivery";

export type PushSubscriptionPayload = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

// Image paths are either absolute or API-served (`/avatars/...`,
// `/news/image/...`); a writer whose asset lives elsewhere sends the full URL.
export type NotificationData = {
  threadKey?: string;
  threadLabel?: string;
  icon?: string;
  image?: string;
  senderSteamId?: string;
};

// The bell's buttons, as written by NotificationsService.send / notifyPlayers.
export type NotificationAction = {
  label: string;
  graphql: {
    type: string;
    action: string;
    selection: Record<string, unknown>;
    variables?: Record<string, unknown>;
  };
};

export type NotificationRow = {
  id: string;
  type: string;
  role: e_player_roles_enum;
  title: string;
  message: string;
  entity_id?: string | null;
  data?: NotificationData | null;
  actions?: NotificationAction[] | null;
};

// A notification button as the service worker sees it: an id to match the
// click against and a ready-to-POST GraphQL operation, so the worker never
// has to know how to build one.
export type PushAction = {
  action: string;
  title: string;
  operation: { query: string; variables?: Record<string, unknown> };
};

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// One (notification, recipient, device) triple. The row fields repeat per
// device, which costs a few duplicated strings and saves a second query.
type DeliveryRow = NotificationRow & {
  steam_id: string;
  quiet_seconds: number;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// Everything owed to one player on one thread, once preferences, quiet hours
// and the seen check have had their say.
type Delivery = {
  steamId: string;
  notifications: NotificationRow[];
  subscriptions: SubscriptionRow[];
  // Seconds until this recipient's quiet window closes, 0 when they are not in
  // one. Held rather than dropped, so a night of messages arrives as one
  // summary in the morning instead of as nothing at all.
  quietSeconds: number;
};

// Which rows to consider. `ids` is the exact set a writer just inserted;
// `window` re-derives them from (type, entity_id) for a fan-out too large to
// carry a payload for.
type DeliverySelector =
  | { ids: string[] }
  | { type: string; entityId: string; withinMinutes: number };

export type SubscriptionStats = {
  subscriptions: number;
  players: number;
  active_7d: number;
  new_7d: number;
  never_delivered: number;
  last_delivered_at: string | null;
  platforms: Array<{ platform: string; devices: number }>;
};

// The roles a role-broadcast notification is addressed to, mirroring the
// select_permissions in
// hasura/metadata/databases/default/tables/public_notifications.yaml.
//
// Only these three roles broadcast. Anything else -- `user` above all -- has
// no select_permission that matches on role, so a row targeting one and
// carrying no steam_id is invisible in the bell; pushing it would buzz a phone
// about something the player cannot then open. Those fall through to the empty
// list below and reach nobody, which is what notifyActivePlayers exists to
// avoid by writing a row per player instead.
//
// Within the three, seniority carries: a match_organizer broadcast is for
// everyone who could act on it, which includes the tournament organizers and
// administrators above them. It did not used to -- "Tournament match requires
// admin attention" was addressed to tournament_organizer and reached exactly
// the role named, never an administrator.
//
// Widening this means widening BOTH permissions in that yaml. Widening select
// alone is what once left admins staring at broadcasts they had no update
// permission to dismiss.
const BROADCAST_ROLES: e_player_roles_enum[] = [
  "match_organizer",
  "tournament_organizer",
  "administrator",
];

const RECIPIENT_ROLES: Record<string, e_player_roles_enum[]> =
  Object.fromEntries(
    BROADCAST_ROLES.map((role) => [role, rolesAtOrAbove(role)]),
  );

// Types that fan out to one row per player. The trigger fires per row, so for
// these the handler collapses into a single deduped job instead of doing a
// query and a send for each of thousands of inserts.
const BATCHED_TYPES = new Set<string>([
  "TournamentCreated",
  "NewsPublished",
  // Every fan-out belongs here, whether notifyActivePlayers or notifyPlayers
  // wrote it. Both claim their own burst, so this only matters when that claim
  // fails -- and the point of the claim failing is to degrade to one batched
  // job, not to one send per player.
  "SeasonEnded",
  // Six months of the sanctioned player's team-mates, every row carrying their
  // steam id as the entity, which is what the jobId collapses on.
  "PlayerSanctioned",
]);

const SEND_CHUNK_SIZE = 25;

const fanOutClaimKey = (id: string) => `notifications:fan-out:${id}`;

// Long enough to outlast Hasura's delivery of the last row in a fan-out,
// including its retry_conf (3 retries, 10s apart, 60s timeout each).
const FAN_OUT_CLAIM_TTL_SECONDS = 900;

// The open bundling window for one player on one thread. Its presence is what
// says "this player has already been buzzed about this recently"; its value is
// the token that scopes the trailing job's id to this window and no other.
const windowKey = (steamId: string, thread: string) =>
  `notifications:push-window:${steamId}:${thread}`;

// What arrived while that window was open and still owes a summary.
const pendingKey = (steamId: string, thread: string) =>
  `notifications:push-pending:${steamId}:${thread}`;

// Outlives its window by a wide margin, so a worker that is briefly behind
// still finds its payload. Nothing depends on the exact figure -- the window
// key is what governs correctness -- but it has to scale with the window: a
// quiet-hours hold runs for hours, and a fixed fifteen minutes would throw the
// night away before anyone woke up.
const pendingTtlFor = (windowSeconds: number) =>
  Math.max(900, windowSeconds + 300);

@Injectable()
export class PushNotificationsService {
  // How far back a batched send resolves the rows of one burst, and so how wide
  // the bucket in batchJobId is. The two have to agree: a job id that outlives
  // the window it covers swallows a burst nothing will ever send.
  public static readonly BATCH_WINDOW_MINUTES = 15;

  private readonly appConfig: AppConfig;
  private readonly webPushConfig: WebPushConfig;
  private readonly redis: Redis;
  private publicKey: string | null = null;
  private configured = false;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly configService: ConfigService,
    @InjectQueue(NotificationsQueues.PushDelivery)
    private readonly pushDeliveryQueue: Queue,
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

  // The id a burst collapses onto. Bucketed by time as well as by entity: the
  // entity alone is stable for a type that can happen to the same entity twice.
  // PlayerSanctioned keys on the sanctioned player's steam id, so muting a
  // player at 10:00 and banning them at 10:20 produced the same jobId, and
  // BullMQ rejected the second burst as a duplicate of the completed job it
  // retains for an hour -- nobody was told about the ban. Worst case a burst
  // straddles a bucket edge and sends twice, which the device collapses on its
  // tag; that is the direction this code already prefers to fail in.
  public static batchJobId(
    type: string,
    entityId: string | undefined,
    at: number = Date.now(),
  ): string {
    const bucket = Math.floor(
      at / (PushNotificationsService.BATCH_WINDOW_MINUTES * 60_000),
    );

    return `push-broadcast.${type}.${entityId}.${bucket}`;
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

  // A single row, straight off the INSERT event trigger.
  //
  // Note the re-read by id rather than trusting the event payload: Hasura
  // builds that payload with row_to_json, and JSON.parse rounds anything past
  // 2^53 -- which every steam id is, by about eight times.
  public async sendForNotification(
    notification: Pick<NotificationRow, "id" | "type">,
  ): Promise<void> {
    if (!this.configured) {
      return;
    }

    const [row] = await this.postgres.query<NotificationRow[]>(
      `${PushNotificationsService.SELECT_NOTIFICATION}
        WHERE id = $1::uuid`,
      [notification.id],
    );

    if (!row) {
      return;
    }

    await this.send({ ids: [row.id] }, row);
  }

  // The counterpart for a fan-out whose recipients are known: one pass over the
  // exact rows the insert produced. Preferred over sendForBatch wherever the
  // ids are to hand — it carries no time window, so it can never pick up a row
  // from an earlier message and push someone their own words back at them.
  public async sendForIds(ids: string[]): Promise<void> {
    if (!this.configured || ids.length === 0) {
      return;
    }

    const row = await this.newestOf({ ids });

    if (!row) {
      return;
    }

    await this.send({ ids }, row);
  }

  // The batched counterpart: one job per (type, entity_id) resolves every row
  // that fan-out just inserted, rather than one query and send per row.
  public async sendForBatch(type: string, entityId: string): Promise<void> {
    if (!this.configured) {
      return;
    }

    const selector = {
      type,
      entityId,
      withinMinutes: PushNotificationsService.BATCH_WINDOW_MINUTES,
    };
    const row = await this.newestOf(selector);

    if (!row) {
      return;
    }

    await this.send(selector, row);
  }

  // The trailing edge of a bundling window: everything that arrived while one
  // player was already being buzzed about this thread, collapsed into the one
  // replacement notification the device shows in place of the first.
  public async sendPending(steamId: string, thread: string): Promise<void> {
    // Released before anything else can fail. A window left standing over a
    // thread nobody is being told about would swallow the next burst's leading
    // push too, and go on doing it until it expired.
    const released = this.redis.del(windowKey(steamId, thread));

    const drained = await this.redis
      .multi()
      .lrange(pendingKey(steamId, thread), 0, -1)
      .del(pendingKey(steamId, thread))
      .exec();

    await released;

    const ids = [...new Set((drained?.at(0)?.at(1) as string[]) ?? [])];

    if (!this.configured || ids.length === 0) {
      return;
    }

    const newest = await this.newestOf({ ids });

    if (!newest) {
      return;
    }

    const policy =
      deliveryPolicyForType(newest.type) ?? DEFAULT_DELIVERY_POLICY;

    // Re-resolved rather than replayed: the whole point of holding these was
    // that the player might read them in the meantime, and between the window
    // opening and now is exactly when that happens.
    const deliveries = (
      await this.resolveDeliveries({ ids }, policy, newest)
    ).filter((delivery) => delivery.steamId === steamId);

    if (deliveries.length === 0) {
      return;
    }

    const focused = await this.filterFocusedOn([steamId], thread);

    if (focused.has(steamId)) {
      return;
    }

    for (const delivery of deliveries) {
      // Asleep by the time the window closed. A bundling window opened a few
      // seconds before quiet hours began closes inside them, and delivering on
      // that is exactly the buzz the hold exists to prevent -- so it is held
      // again, now against the rest of the night.
      if (delivery.quietSeconds > 0) {
        const claim = await this.claimWindow(
          steamId,
          thread,
          delivery.quietSeconds,
        );

        if (claim.leading) {
          await this.resetPending(steamId, thread, ids, claim.ttl);
        } else {
          await this.appendPending(steamId, thread, ids, claim.ttl);
        }

        await this.scheduleTrailing(steamId, thread, claim.token, claim.ttl);
        continue;
      }

      // Counted from the window rather than from the rows that survived it.
      //
      // collapseOlderUnread soft-deletes every superseded ChatMessage row so
      // the bell shows one entry per conversation, and requireUnseen drops
      // soft-deleted rows -- so resolving a burst of four finds one survivor.
      // The window is what actually knows how many arrived; the surviving rows
      // are only there to say whether it is still worth sending at all, and to
      // supply the text.
      await this.deliver(
        delivery.steamId,
        delivery.subscriptions,
        delivery.notifications,
        ids.length,
      );
    }
  }

  private static readonly SELECT_NOTIFICATION = `SELECT id::text AS id, type::text AS type, role::text AS role,
              title, message, entity_id, data, actions
         FROM public.notifications`;

  // The row a bundle is described by: its thread, its policy, and the link the
  // notification opens.
  private async newestOf(
    selector: DeliverySelector,
  ): Promise<NotificationRow | undefined> {
    const [row] =
      "ids" in selector
        ? await this.postgres.query<NotificationRow[]>(
            `${PushNotificationsService.SELECT_NOTIFICATION}
              WHERE id = ANY($1::uuid[])
              ORDER BY created_at DESC
              LIMIT 1`,
            [selector.ids],
          )
        : await this.postgres.query<NotificationRow[]>(
            `${PushNotificationsService.SELECT_NOTIFICATION}
              WHERE type = $1 AND entity_id = $2
              ORDER BY created_at DESC
              LIMIT 1`,
            [selector.type, selector.entityId],
          );

    return row;
  }

  private async send(
    selector: DeliverySelector,
    representative: NotificationRow,
  ): Promise<void> {
    const policy =
      deliveryPolicyForType(representative.type) ?? DEFAULT_DELIVERY_POLICY;

    await this.dispatch(
      await this.resolveDeliveries(selector, policy, representative),
      policy,
    );
  }

  // Recipients, role visibility, push preference, quiet hours and the seen
  // check, in one indexed statement, grouped by the player they are owed to.
  //
  // Grouping matters: bundling is per player, not per notification. A chat
  // message writes one row per member of the lobby, and each of those members
  // is on their own window.
  private async resolveDeliveries(
    selector: DeliverySelector,
    policy: DeliveryPolicy,
    representative: NotificationRow,
  ): Promise<Delivery[]> {
    const [selectorSql, selectorParams]: [
      string,
      Array<string | number | string[]>,
    ] =
      "ids" in selector
        ? [`n.id = ANY($1::uuid[])`, [selector.ids]]
        : [
            `n.type = $1
              AND n.entity_id = $2
              AND n.created_at > now() - make_interval(mins => $3::int)`,
            [selector.type, selector.entityId, selector.withinMinutes],
          ];

    const category = pushCategoryForType(representative.type);

    if (!category) {
      // Fail open: a type nobody has categorised yet still gets delivered.
      // notification-categories.spec.ts is what stops this happening.
      this.logger.warn(
        `no push category for notification type ${representative.type}`,
      );
    }

    const next = selectorParams.length;

    const rows = await this.postgres.query<DeliveryRow[]>(
      `SELECT n.id::text AS id, n.type::text AS type, n.role::text AS role,
              n.title, n.message, n.entity_id, n.data, n.actions,
              p.steam_id::text AS steam_id,
              public.quiet_hours_seconds_remaining(
                p.quiet_hours_start, p.quiet_hours_end, p.notification_timezone
              ) AS quiet_seconds,
              ps.id::text AS subscription_id, ps.endpoint, ps.p256dh, ps.auth
         FROM public.notifications n
         JOIN public.players p
           ON (n.steam_id IS NOT NULL AND p.steam_id = n.steam_id)
           OR (n.steam_id IS NULL AND p.role::text = ANY($${next + 1}::text[]))
         JOIN public.push_subscriptions ps ON ps.steam_id = p.steam_id
    LEFT JOIN public.notification_preferences np
           ON np.steam_id = p.steam_id
          AND np.channel = 'push'
          AND np.key = $${next + 2}
    -- Only ever matches a row whose writer declared a thread, which today is
    -- chat and nothing else. Anything without one joins to NULL and passes.
    LEFT JOIN public.chat_read_state crs
           ON crs.steam_id = p.steam_id
          AND crs.thread = n.data->>'threadKey'
        WHERE ${selectorSql}
          AND COALESCE(np.enabled, $${next + 3}::boolean) = true
          -- Dealt with in the bell between the insert and now.
          AND ($${next + 4}::boolean = false
               OR (n.is_read = false AND n.deleted_at IS NULL))
          -- Or read in the conversation itself, which never touches the bell.
          AND (crs.last_read_at IS NULL OR n.created_at > crs.last_read_at)
        ORDER BY n.created_at ASC`,
      [
        ...selectorParams,
        RECIPIENT_ROLES[representative.role] ?? [],
        category?.key ?? "",
        category?.defaultEnabled ?? true,
        policy.requireUnseen,
      ],
    );

    const byRecipient = new Map<string, Delivery>();

    for (const row of rows) {
      let delivery = byRecipient.get(row.steam_id);

      if (!delivery) {
        delivery = {
          steamId: row.steam_id,
          notifications: [],
          subscriptions: [],
          quietSeconds: Number(row.quiet_seconds ?? 0),
        };
        byRecipient.set(row.steam_id, delivery);
      }

      if (!delivery.notifications.some(({ id }) => id === row.id)) {
        delivery.notifications.push({
          id: row.id,
          type: row.type,
          role: row.role,
          title: row.title,
          message: row.message,
          entity_id: row.entity_id,
          data: row.data,
          actions: row.actions,
        });
      }

      if (
        !delivery.subscriptions.some(({ id }) => id === row.subscription_id)
      ) {
        delivery.subscriptions.push({
          id: row.subscription_id,
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
        });
      }
    }

    return [...byRecipient.values()];
  }

  // Buzz now, hold for a summary, or say nothing at all.
  private async dispatch(
    deliveries: Delivery[],
    policy: DeliveryPolicy,
  ): Promise<void> {
    if (deliveries.length === 0) {
      return;
    }

    // One dispatch only ever covers one notification type and entity, so every
    // recipient here is on the same thread.
    const thread = threadKeyFor(deliveries.at(0).notifications.at(0));

    const focused = await this.filterFocusedOn(
      deliveries.map(({ steamId }) => steamId),
      thread,
    );

    for (const delivery of deliveries) {
      // Reading it is the notification. Anything more is the app tapping the
      // player on the shoulder to tell them what is already on their screen.
      if (focused.has(delivery.steamId)) {
        continue;
      }

      const ids = delivery.notifications.map(({ id }) => id);

      // Asleep. Hold everything until the window closes and let the trailing
      // job deliver it as one summary -- which is the same machinery bundling
      // already uses, just with a much longer window.
      if (delivery.quietSeconds > 0) {
        const claim = await this.claimWindow(
          delivery.steamId,
          thread,
          delivery.quietSeconds,
        );

        if (claim.leading) {
          await this.resetPending(delivery.steamId, thread, ids, claim.ttl);
        } else {
          await this.appendPending(delivery.steamId, thread, ids, claim.ttl);
        }

        await this.scheduleTrailing(
          delivery.steamId,
          thread,
          claim.token,
          claim.ttl,
        );
        continue;
      }

      if (policy.bundleSeconds === 0) {
        await this.deliver(
          delivery.steamId,
          delivery.subscriptions,
          delivery.notifications,
        );
        continue;
      }

      const claim = await this.claimWindow(
        delivery.steamId,
        thread,
        policy.bundleSeconds,
      );

      if (claim.leading) {
        await this.deliver(
          delivery.steamId,
          delivery.subscriptions,
          delivery.notifications,
        );

        // Held as well as sent. The summary replaces this notification on the
        // device, so leaving it out would make a burst of four report three.
        // The list is reset rather than appended to, so a window that closed
        // without ever being drained cannot leak into the next one's count.
        await this.resetPending(delivery.steamId, thread, ids, claim.ttl);
        continue;
      }

      await this.appendPending(delivery.steamId, thread, ids, claim.ttl);
      await this.scheduleTrailing(
        delivery.steamId,
        thread,
        claim.token,
        claim.ttl,
      );
    }
  }

  // Opens the bundling window for one player on one thread, or reports that
  // somebody already has.
  //
  // SET NX EX settles it in a single round trip, which is what makes it safe
  // across pods -- two of them handling the same burst cannot both decide they
  // are the leading edge. The token scopes the trailing job's id to this window
  // and no other; a static id would be blocked by its own completed job for as
  // long as BullMQ kept the record.
  private async claimWindow(
    steamId: string,
    thread: string,
    bundleSeconds: number,
  ): Promise<{ leading: boolean; token?: string; ttl?: number }> {
    const key = windowKey(steamId, thread);

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = `${Date.now()}`;
      const claimed = await this.redis.set(
        key,
        token,
        "EX",
        bundleSeconds,
        "NX",
      );

      if (claimed) {
        return { leading: true, token, ttl: bundleSeconds };
      }

      const [held, ttl] = await Promise.all([
        this.redis.get(key),
        this.redis.ttl(key),
      ]);

      // Expired between losing the race and reading it. Going round again
      // takes the leading edge rather than scheduling a summary against a
      // window that no longer exists.
      if (held === null || ttl < 0) {
        continue;
      }

      return { leading: false, token: held, ttl };
    }

    // Both attempts lost the race and both then found the key already gone.
    // Claimed outright rather than merely reported: a leading edge with no
    // window standing behind it opens a bundle nothing will ever drain, and
    // the next message takes the leading edge again and delivers on its own.
    const token = `${Date.now()}`;

    await this.redis.set(key, token, "EX", bundleSeconds);

    return { leading: true, token, ttl: bundleSeconds };
  }

  // Starts a window's tally at the notification that opened it.
  private async resetPending(
    steamId: string,
    thread: string,
    ids: string[],
    windowSeconds: number,
  ): Promise<void> {
    const key = pendingKey(steamId, thread);

    await this.redis
      .multi()
      .del(key)
      .rpush(key, ...ids)
      .expire(key, pendingTtlFor(windowSeconds))
      .exec();
  }

  private async appendPending(
    steamId: string,
    thread: string,
    ids: string[],
    windowSeconds: number,
  ): Promise<void> {
    const key = pendingKey(steamId, thread);

    await this.redis.rpush(key, ...ids);
    await this.redis.expire(key, pendingTtlFor(windowSeconds));
  }

  private async scheduleTrailing(
    steamId: string,
    thread: string,
    token: string,
    ttl: number,
  ): Promise<void> {
    await this.pushDeliveryQueue.add(
      // The class name, not the queue's: UseQueue registers handlers under it,
      // and the generic processor looks the job up by the name it was added
      // with. Spelled out rather than referenced, or importing the job here
      // would close a cycle back through its own constructor.
      "SendPushDelivery",
      { steamId, thread },
      {
        // Encoded, not interpolated raw: BullMQ rejects a custom id
        // containing ":", and every thread key is colon-joined
        // (`chat:match:m-1`). Encoding keeps threads that differ only in a
        // colon on separate jobs, which stripping would not.
        jobId: `push-trail.${steamId}.${encodeURIComponent(thread)}.${token}`,
        delay: Math.max(ttl, 1) * 1000,
        // Not `{ age }`: a completed job holding its id would stop the next
        // window with the same token from ever being scheduled.
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
      },
    );
  }

  // Which of these players is looking at the thread right now. One pipeline for
  // the whole recipient list -- a busy match lobby resolves nine of these per
  // message.
  private async filterFocusedOn(
    steamIds: string[],
    thread: string,
  ): Promise<Set<string>> {
    if (steamIds.length === 0) {
      return new Set();
    }

    const pipeline = this.redis.pipeline();

    for (const steamId of steamIds) {
      pipeline.hvals(presenceFocusKey(steamId));
    }

    const results = await pipeline.exec();
    const focused = new Set<string>();

    for (const [index, steamId] of steamIds.entries()) {
      const [error, values] = results?.at(index) ?? [];

      if (error || !Array.isArray(values)) {
        continue;
      }

      if ((values as string[]).includes(thread)) {
        focused.add(steamId);
      }
    }

    return focused;
  }

  // A lone message names its sender, but not which of a dozen rooms it came
  // from -- the label was only ever reached once a bundle replaced it, so a
  // single message pushed as "Luke" and left the player to open it to find
  // out where from. A DM is labelled by its sender, so there the label would
  // only repeat the title.
  private static titleFor(notification: NotificationRow): string {
    const label = notification.data?.threadLabel;

    return label && label !== notification.title
      ? `${notification.title} · ${label}`
      : notification.title;
  }

  // What a bundle says when it replaces the notification already on the device.
  private static summarize(
    notifications: NotificationRow[],
    count: number,
  ): {
    title: string;
    body: string;
  } {
    const newest = notifications.at(-1);
    // Chat puts the sender in `title` and the room in `threadLabel`; every
    // other type has one title for the whole thread and no label at all.
    const names = [...new Set(notifications.map(({ title }) => title))];
    const noun = newest.type.endsWith("ChatMessage")
      ? "messages"
      : "notifications";

    // One sender, so the title is still theirs -- and still needs the room
    // said, for the same reason a single message does.
    if (names.length === 1) {
      return {
        title: PushNotificationsService.titleFor(newest),
        body: `${count} new ${noun}`,
      };
    }

    const from =
      names.length <= 2
        ? names.join(" and ")
        : `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;

    return {
      title: newest.data?.threadLabel ?? newest.title,
      body: `${count} new ${noun} from ${from}`,
    };
  }

  // Same rule as web/utilities/avatarUrl.ts: a stored `avatars/...` path (with
  // or without its leading slash) is served by the API; anything with a scheme
  // is left alone. The browser fetches a notification image from the push
  // service's context, not the page's, so it has to be a full URL.
  private assetUrl(path: string | undefined | null): string | undefined {
    if (!path) {
      return undefined;
    }

    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    // `//evil.test/x` is a fully qualified URL to somewhere else; any other
    // scheme the browser would refuse anyway.
    if (path.startsWith("//") || /^[a-z][a-z\d+\-.]*:/i.test(path)) {
      return undefined;
    }

    return `${this.appConfig.apiDomain}/${path.replace(/^\/+/, "")}`;
  }

  private static markReadSelection(ids: string[]) {
    return {
      update_notifications: {
        __args: {
          where: { id: { _in: ids } },
          _set: { is_read: true },
        },
        affected_rows: true,
      },
    };
  }

  // One button: the mutation the bell would run for it, followed by marking
  // the rows read -- which is what the bell does after any of its buttons
  // (AppNotifications.vue handleAction), so the push stays in step.
  private static pushAction(
    action: string,
    title: string,
    mutation: Record<string, unknown>,
    ids: string[],
  ): PushAction {
    return {
      action,
      title,
      operation: generateMutationOp({
        ...mutation,
        ...PushNotificationsService.markReadSelection(ids),
      } as Parameters<typeof generateMutationOp>[0]),
    };
  }

  // What the device can offer besides opening the app. Every operation runs
  // from the service worker with the player's own cookie, so it is exactly as
  // privileged as the same button in the bell.
  private static pushActionsFor(
    notifications: NotificationRow[],
    count: number,
  ): PushAction[] {
    const newest = notifications.at(-1);
    const ids = notifications.map(({ id }) => id);

    // Marking a bell row read says nothing about the conversation's own read
    // cursor, and a "Dismiss" that leaves the thread unread would mislead.
    if (newest.type.endsWith("ChatMessage")) {
      return [];
    }

    const dismiss = [
      PushNotificationsService.pushAction("dismiss", "Dismiss", {}, ids),
    ];

    // A bundle describes several things at once; the only honest button is
    // the one that applies to all of them.
    if (count > 1 || notifications.length > 1) {
      return dismiss;
    }

    if (newest.actions?.length) {
      return newest.actions.map(({ label, graphql }, index) =>
        PushNotificationsService.pushAction(
          String(index),
          label,
          {
            [graphql.action]: {
              __args: graphql.variables ?? {},
              ...graphql.selection,
            },
          },
          ids,
        ),
      );
    }

    // The invites are answered from the bell by components of their own rather
    // than through `actions` (ActionToasts.vue, DraftInviteNotification.vue),
    // so their buttons are spelled out here with the same mutations.
    const inviteType =
      newest.type === "TeamInvite"
        ? "team"
        : newest.type === "TournamentTeamInvite"
          ? "tournament"
          : null;

    if (inviteType && newest.entity_id) {
      const variables = { type: inviteType, invite_id: newest.entity_id };

      return [
        PushNotificationsService.pushAction(
          "accept",
          "Accept",
          { acceptInvite: { __args: variables, success: true } },
          ids,
        ),
        PushNotificationsService.pushAction(
          "decline",
          "Decline",
          { denyInvite: { __args: variables, success: true } },
          ids,
        ),
      ];
    }

    if (newest.type === "DraftInvite" && newest.entity_id) {
      return [true, false].map((accept) =>
        PushNotificationsService.pushAction(
          accept ? "accept" : "decline",
          accept ? "Accept" : "Decline",
          {
            respondDraftInvite: {
              __args: { draftGameId: newest.entity_id, accept },
              success: true,
            },
          },
          ids,
        ),
      );
    }

    return dismiss;
  }

  // What the app icon should say once this push lands. Only rows the bell
  // would show this player; the bell's own number also counts invites and the
  // like, and the page re-syncs the badge from that the moment it is open.
  private async unreadCount(steamId: string): Promise<number | undefined> {
    try {
      const rows = await this.postgres.query<Array<{ unread: string }>>(
        `SELECT count(*)::text AS unread
           FROM public.notifications
          WHERE steam_id = $1
            AND in_app = true
            AND is_read = false
            AND deleted_at IS NULL`,
        [steamId],
      );

      const unread = Number(rows.at(0)?.unread);

      return Number.isInteger(unread) ? unread : undefined;
    } catch (error) {
      this.logger.warn(
        `unable to count unread notifications for ${steamId}`,
        error,
      );
      return undefined;
    }
  }

  private async deliver(
    steamId: string,
    subscriptions: SubscriptionRow[],
    notifications: NotificationRow[],
    // How many arrived, which is not always how many rows are left to describe
    // them. See sendPending.
    count = notifications.length,
  ): Promise<void> {
    if (subscriptions.length === 0 || notifications.length === 0) {
      return;
    }

    const newest = notifications.at(-1);
    const thread = threadKeyFor(newest);

    const { title, body } =
      count <= 1
        ? {
            title: PushNotificationsService.titleFor(newest),
            body: stripHtml(newest.message),
          }
        : PushNotificationsService.summarize(notifications, count);

    // A row whose stored action no longer matches the schema must not take
    // the notification down with it; it just loses its buttons.
    let actions: PushAction[] = [];

    try {
      actions = PushNotificationsService.pushActionsFor(notifications, count);
    } catch (error) {
      this.logger.warn(`unable to build push actions for ${newest.id}`, error);
    }

    const payload = JSON.stringify({
      title,
      body,
      url: notificationUrl(newest, this.appConfig.webDomain),
      icon: this.assetUrl(newest.data?.icon),
      image: this.assetUrl(newest.data?.image),
      // Lets a device collapse repeats of the same conversation or match
      // rather than stacking a separate notification for each.
      tag: thread,
      // A replacement under an existing tag is silent by default, which would
      // make the summary that closes a burst arrive unannounced. Requires
      // `tag`, which is always set above.
      renotify: true,
      threadKey: thread,
      count,
      unread: await this.unreadCount(steamId),
      actions,
      graphqlUrl: `${this.appConfig.apiDomain}/v1/graphql`,
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
