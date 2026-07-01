import { randomUUID } from "crypto";
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import SteamUser from "steam-user";
import { AppConfig } from "src/configs/types/AppConfig";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { SteamMatchHistoryQueues } from "../steam-match-history/enums/SteamMatchHistoryQueues";
import {
  Cs2PresenceState,
  isMatchEndTransition,
  parseCs2Presence,
} from "./presence";

type FriendsAccount = {
  id: string;
  username: string;
  password: string;
};

type ImportedMatchPlayer = {
  steamId: string;
  kills: number;
  deaths: number;
};

export type MatchImportedNotice = {
  matchId: string;
  matchType: string;
  mapName: string | null;
  players: ImportedMatchPlayer[];
};

const LOCK_TTL_SECONDS = 30;
const TICK_MS = 10_000;
const PRESENCE_STATE_TTL_SECONDS = 24 * 60 * 60;
const CHAT_CHANNEL = "steam-presence:send-chat";
const GUARD_CODE_CHANNEL = "steam-presence:guard-code";
// Per-account "this bot is waiting for a Steam Guard code" marker, surfaced to
// the admin UI. TTL'd because the login attempt itself eventually times out.
const GUARD_PREFIX = "steam-presence:guard:";
const GUARD_TTL_SECONDS = 300;

const REFRESH_TOKEN_PREFIX = "steam-presence:refresh-token:";
const ACCOUNT_LOCK_PREFIX = "steam-presence:account-lock:";
const STATE_PREFIX = "steam-presence:state:";
// Per-account "this account is logged in right now" marker (TTL-refreshed by the
// owning pod), so the admin view can show live online status across pods.
const ONLINE_PREFIX = "steam-presence:online:";
// Delay before polling match history after a match ends, so Valve has time to
// publish the demo + share code.
const IMPORT_DELAY_MS = 60_000;
// Admin kill-switch. Absent/anything-but-'false' => enabled (always-on default).
// 'public.' prefix matches the settings convention (guest-readable, like
// public.external_matches_enabled).
const SETTING_ENABLED = "public.steam_presence_enabled";

export type PresenceAdminStatus = {
  enabled: boolean;
  pool: {
    bots: number;
    online: number;
    watching: number;
    pending: number;
    capacity: number;
  };
  bots: Array<{
    id: string;
    username: string;
    steamId: string | null;
    steamLevel: number | null;
    online: boolean;
    needs2fa: boolean;
    guardType: "email" | "app" | null;
    guardLastWrong: boolean;
    watching: number;
    assigned: number;
    capacity: number;
  }>;
};

// CAS: only act on a key we still own.
const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

@Injectable()
export class SteamPresenceService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly instanceId = randomUUID();
  private readonly appConfig: AppConfig;
  private redis!: Redis;
  private subscriber?: Redis;
  private tickTimer?: NodeJS.Timeout;

  // accountId -> live steam-user client we own and are running.
  private readonly clients = new Map<string, SteamUser>();
  // accountIds for which we currently hold the Redis lock.
  private readonly owned = new Set<string>();
  // accountIds whose client has logged on (drives the online heartbeat).
  private readonly connected = new Set<string>();
  // Pending Steam Guard callbacks, keyed by accountId. Only the owning pod has
  // these (they're in-memory closures from steam-user's `steamGuard` event).
  private readonly pendingGuards = new Map<string, (code: string) => void>();

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
    @InjectQueue(SteamMatchHistoryQueues.PollSteamMatchHistoryForUser)
    private readonly pollQueue: Queue,
  ) {
    this.appConfig = this.config.get<AppConfig>("app");
  }

  // Always-on by default: the pool is a no-op unless friends-role accounts
  // exist, so adding an account is the real "enable". This is just an admin
  // kill-switch — only an explicit 'false' disables it.
  public async isEnabled(): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SETTING_ENABLED],
    );
    return rows.at(0)?.value !== "false";
  }

  onApplicationBootstrap(): void {
    this.redis = this.redisManager.getConnection();
    this.subscriber = this.redis.duplicate();
    void this.subscriber.subscribe(CHAT_CHANNEL, GUARD_CODE_CHANNEL);
    this.subscriber.on("message", (channel, message) => {
      if (channel === CHAT_CHANNEL) {
        void this.handleChatRequest(message);
      } else if (channel === GUARD_CODE_CHANNEL) {
        void this.handleGuardCode(message);
      }
    });

    this.tickTimer = setInterval(() => void this.syncPool(), TICK_MS);
    this.tickTimer.unref?.();
    void this.syncPool();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.subscriber) {
      await this.subscriber.unsubscribe(CHAT_CHANNEL).catch(() => {});
      this.subscriber.disconnect();
    }
    for (const accountId of [...this.owned]) {
      await this.teardownAccount(accountId, true);
    }
  }

  // ---- pool ownership (cross-pod sharding via per-account Redis locks) ------

  private async syncPool(): Promise<void> {
    if (!(await this.isEnabled())) {
      // Kill-switch flipped off: drop everything we hold.
      if (this.owned.size > 0) {
        this.logger.log("steam-presence disabled via settings, disconnecting");
        for (const accountId of [...this.owned]) {
          await this.teardownAccount(accountId, true);
        }
      }
      return;
    }

    let accounts: FriendsAccount[];
    try {
      accounts = await this.postgres.query<FriendsAccount[]>(
        `SELECT id::text, username, password
           FROM public.steam_accounts
          WHERE role = 'friends'`,
      );
    } catch (err) {
      this.logger.error(
        `steam-presence pool query failed: ${(err as Error).message}`,
      );
      return;
    }

    const desired = new Set(accounts.map((a) => a.id));

    // Drop accounts we own that are no longer friends-role.
    for (const accountId of [...this.owned]) {
      if (!desired.has(accountId)) {
        await this.teardownAccount(accountId, true);
      }
    }

    for (const account of accounts) {
      const ownedAlready = this.owned.has(account.id);
      const have = ownedAlready
        ? await this.renewLock(account.id)
        : await this.acquireLock(account.id);

      if (!have) {
        if (ownedAlready) {
          // Lost the lock (e.g. a stall let another pod grab it).
          await this.teardownAccount(account.id, false);
        }
        continue;
      }

      this.owned.add(account.id);
      if (!this.clients.has(account.id)) {
        this.connectAccount(account);
      }
    }

    // Refresh the online heartbeat for accounts we run. Presence itself is
    // push-based via the steam-user `user` event — no polling.
    for (const accountId of this.connected) {
      await this.redis
        .set(ONLINE_PREFIX + accountId, this.instanceId, "EX", LOCK_TTL_SECONDS)
        .catch(() => {});
    }
  }

  private async acquireLock(accountId: string): Promise<boolean> {
    const ok = await this.redis.set(
      ACCOUNT_LOCK_PREFIX + accountId,
      this.instanceId,
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );
    return ok === "OK";
  }

  private async renewLock(accountId: string): Promise<boolean> {
    const renewed = await this.redis.eval(
      RENEW_LUA,
      1,
      ACCOUNT_LOCK_PREFIX + accountId,
      this.instanceId,
      String(LOCK_TTL_SECONDS),
    );
    return renewed === 1;
  }

  // ---- per-account steam client ------------------------------------------

  private connectAccount(account: FriendsAccount): void {
    this.logger.log(`steam-presence connecting bot account ${account.username}`);
    const client = new SteamUser({
      enablePicsCache: false,
      autoRelogin: true,
    });
    this.clients.set(account.id, client);

    client.on("refreshToken", (token: string) => {
      void this.cache.put(REFRESH_TOKEN_PREFIX + account.id, token);
    });

    // Steam Guard: pause login and ask an admin for the code via the web UI.
    // `domain` is set for email-based guard, null for the mobile authenticator.
    client.on(
      "steamGuard",
      (
        domain: string | null,
        callback: (code: string) => void,
        lastCodeWrong: boolean,
      ) => {
        const type = domain ? "email" : "app";
        this.pendingGuards.set(account.id, callback);
        void this.redis.set(
          GUARD_PREFIX + account.id,
          JSON.stringify({ type, lastWrong: !!lastCodeWrong }),
          "EX",
          GUARD_TTL_SECONDS,
        );
        this.logger.log(
          `steam-presence ${account.username} needs a Steam Guard ${type} code${lastCodeWrong ? " (previous code was wrong)" : ""}`,
        );
      },
    );

    client.on("loggedOn", () => {
      const steamId = client.steamID?.getSteamID64();
      this.logger.log(
        `steam-presence ${account.username} logged on as ${steamId}`,
      );
      client.setPersona(SteamUser.EPersonaState.Online);
      this.connected.add(account.id);
      // Login succeeded — clear any pending Steam Guard prompt.
      this.pendingGuards.delete(account.id);
      void this.redis.del(GUARD_PREFIX + account.id).catch(() => {});
      void this.redis
        .set(ONLINE_PREFIX + account.id, this.instanceId, "EX", LOCK_TTL_SECONDS)
        .catch(() => {});
      if (steamId) {
        void this.postgres
          .query(
            `UPDATE public.steam_accounts SET steamid64 = $1::bigint, updated_at = now() WHERE id = $2::uuid`,
            [steamId, account.id],
          )
          .catch(() => {});
        this.detectCapacity(client, account.id, steamId);
      }
      this.acceptPendingFriends(client, account.id, steamId);
    });

    client.on("error", (err: Error) => {
      this.logger.error(
        `steam-presence ${account.username} error: ${err.message}`,
      );
      if (err.message.toLowerCase().includes("invalidpassword")) {
        void this.cache.put(REFRESH_TOKEN_PREFIX + account.id, "");
      }
      // Drop the client but keep the lock; the next tick reconnects.
      if (this.clients.get(account.id) === client) {
        this.clients.delete(account.id);
        this.connected.delete(account.id);
        client.removeAllListeners();
        try {
          client.logOff();
        } catch {
          // already disconnected
        }
      }
    });

    client.on(
      "friendRelationship",
      (sid: { getSteamID64(): string }, rel: number) => {
        const steamId = sid.getSteamID64();
        const botSteamId = client.steamID?.getSteamID64();
        // The user adds us (inbound) — auto-accept. We never send invites:
        // Steam rate-limits outbound invites hard; inbound is unrestricted.
        if (rel === SteamUser.EFriendRelationship.RequestRecipient) {
          client.addFriend(steamId, (addErr) => {
            if (addErr) {
              this.logger.warn(
                `steam-presence failed to accept friend ${steamId}: ${addErr.message}`,
              );
              return;
            }
            void this.onFriendAdded(account.id, steamId, botSteamId);
          });
        } else if (rel === SteamUser.EFriendRelationship.Friend) {
          void this.onFriendAdded(account.id, steamId, botSteamId);
        }
      },
    );

    // Push-based presence: Steam sends a `user` event whenever a friend's
    // persona/rich-presence changes (login, launch CS2, join a match, score
    // update, quit) — no polling. The friend persona carries gameid + rich
    // presence, which is what Steam's own friends list renders from.
    client.on(
      "user",
      (
        sid: { getSteamID64?: () => string },
        persona: {
          gameid?: string | number | null;
          rich_presence?:
            | Record<string, string>
            | Array<{ key?: string; value?: string }>;
          rich_presence_string?: string;
        },
      ) => {
        const id = sid?.getSteamID64?.() ?? String(sid);
        void this.handlePresenceState(id, {
          gameid: persona?.gameid ?? null,
          richPresence: persona?.rich_presence ?? {},
          // Steam's own friends-list string, e.g. "In Lobby - Deathmatch".
          display: persona?.rich_presence_string ?? null,
        });
      },
    );

    void this.logOn(client, account);
  }

  private async logOn(client: SteamUser, account: FriendsAccount): Promise<void> {
    const refreshToken = await this.cache.get(REFRESH_TOKEN_PREFIX + account.id);
    if (this.clients.get(account.id) !== client) {
      return;
    }
    if (refreshToken && typeof refreshToken === "string") {
      client.logOn({ refreshToken });
    } else {
      client.logOn({
        accountName: account.username,
        password: account.password,
      });
    }
  }

  private async teardownAccount(
    accountId: string,
    releaseLock: boolean,
  ): Promise<void> {
    const client = this.clients.get(accountId);
    this.clients.delete(accountId);
    this.connected.delete(accountId);
    this.pendingGuards.delete(accountId);
    await this.redis?.del(ONLINE_PREFIX + accountId).catch(() => {});
    await this.redis?.del(GUARD_PREFIX + accountId).catch(() => {});
    if (client) {
      client.removeAllListeners();
      try {
        client.logOff();
      } catch {
        // already disconnected
      }
    }
    if (releaseLock) {
      this.owned.delete(accountId);
      await this.redis
        ?.eval(
          RELEASE_LUA,
          1,
          ACCOUNT_LOCK_PREFIX + accountId,
          this.instanceId,
        )
        .catch(() => {});
    }
  }

  // Steam's friend cap is 250 + 5*level (hard max 2000). Read the bot's level on
  // login and store it as the account's capacity so admins don't guess.
  private detectCapacity(
    client: SteamUser,
    accountId: string,
    steamId: string,
  ): void {
    client.getSteamLevels([steamId], (err, levels) => {
      if (err) {
        return;
      }
      const level = levels?.[steamId];
      if (typeof level !== "number") {
        return;
      }
      const capacity = Math.min(2000, 250 + 5 * level);
      void this.postgres
        .query(
          `UPDATE public.steam_accounts
              SET steam_level = $1, friend_capacity = $2, updated_at = now()
            WHERE id = $3::uuid`,
          [level, capacity, accountId],
        )
        .catch(() => {});
    });
  }

  private acceptPendingFriends(
    client: SteamUser,
    accountId: string,
    botSteamId?: string,
  ): void {
    const friends = client.myFriends ?? {};
    for (const [steamId, rel] of Object.entries(friends)) {
      if (rel === SteamUser.EFriendRelationship.RequestRecipient) {
        client.addFriend(steamId, (addErr) => {
          if (!addErr) {
            void this.onFriendAdded(accountId, steamId, botSteamId);
          }
        });
      }
    }
  }

  private async onFriendAdded(
    accountId: string,
    steamId: string,
    botSteamId?: string,
  ): Promise<void> {
    this.logger.log(`steam-presence friend established ${steamId}`);
    await this.postgres.query(
      `INSERT INTO public.player_steam_bot_friend
         (steam_id, bot_steam_account_id, bot_steamid64, status, friended_at, updated_at)
       VALUES ($1::bigint, $2::uuid, $3::bigint, 'friends', now(), now())
       ON CONFLICT (steam_id) DO UPDATE
         SET bot_steam_account_id = EXCLUDED.bot_steam_account_id,
             bot_steamid64 = EXCLUDED.bot_steamid64,
             status = 'friends',
             friended_at = COALESCE(public.player_steam_bot_friend.friended_at, now()),
             updated_at = now()`,
      [steamId, accountId, botSteamId ?? null],
    );
    // Backfill matches played before they added the bot.
    await this.enqueuePoll(steamId);
  }

  // ---- presence -> poll trigger ------------------------------------------

  private async handlePresenceState(
    steamId: string,
    input: {
      gameid?: string | number | null;
      richPresence: Record<string, string> | Array<{ key?: string; value?: string }>;
      display?: string | null;
    },
  ): Promise<void> {
    const current = parseCs2Presence({
      gameid: input.gameid,
      richPresence: input.richPresence,
      display: input.display,
    });

    const stateKey = STATE_PREFIX + steamId;
    const previous = (await this.cache.get(stateKey)) as Cs2PresenceState | null;

    // Only write when something actually changed. The push `user` event fires
    // often; writing every time would churn Postgres dead tuples for no reason
    // (we only ever keep the latest state, never history).
    if (previous && JSON.stringify(previous) === JSON.stringify(current)) {
      return;
    }
    await this.cache.put(stateKey, current, PRESENCE_STATE_TTL_SECONDS);

    // Mirror the latest onto the friend row (single-row UPDATE, un-indexed jsonb
    // → HOT update). No-op for non-friended steamids.
    await this.postgres
      .query(
        `UPDATE public.player_steam_bot_friend
            SET last_presence_state = $1::jsonb, updated_at = now()
          WHERE steam_id = $2::bigint`,
        [JSON.stringify(current), steamId],
      )
      .catch(() => {});

    // Import trigger: they just finished a Competitive/Premier/Wingman match
    // (deathmatch / arms race never set inMatch, so they never trigger imports).
    // Delay the poll so Valve has time to publish the demo + share code.
    if (isMatchEndTransition(previous, current)) {
      this.logger.log(
        `steam-presence import trigger: ${steamId} finished ${previous?.mode ?? "match"} ` +
          `— scheduling match-history poll in ${IMPORT_DELAY_MS / 1000}s`,
      );
      await this.enqueuePoll(steamId, IMPORT_DELAY_MS);
    }
  }

  private async enqueuePoll(steamId: string, delayMs = 0): Promise<void> {
    // Same jobId as the on-login poll so a pending poll isn't duplicated; the
    // per-user 10-minute cooldown in pollForUser absorbs extra triggers.
    await this.pollQueue
      .add(
        "PollSteamMatchHistoryForUser",
        { steamId },
        {
          jobId: `poll-steam-match-history.${steamId}`,
          delay: delayMs,
          removeOnComplete: true,
          removeOnFail: true,
        },
      )
      .catch((err) => {
        this.logger.error(
          `steam-presence poll enqueue failed for ${steamId}: ${(err as Error)?.message ?? err}`,
        );
      });
  }

  // Short human description of a presence state (unused since the activity feed
  // was removed; kept minimal for potential debug reuse).
  // ---- onboarding / assignment -------------------------------------------

  // Assign (or return the already-assigned) friends-role bot for a user, so the
  // web UI can prompt "add this bot for instant imports". Returns null when the
  // pool is full or no bot is online yet.
  public async assignBotForUser(steamId: string): Promise<{
    steamId: string;
    addUrl: string;
    status: string;
  } | null> {
    const existing = await this.postgres.query<
      Array<{ bot_steamid64: string | null; status: string }>
    >(
      `SELECT bot_steamid64::text, status
         FROM public.player_steam_bot_friend
        WHERE steam_id = $1::bigint`,
      [steamId],
    );
    const existingRow = existing.at(0);
    if (existingRow?.bot_steamid64) {
      return SteamPresenceService.botResult(
        existingRow.bot_steamid64,
        existingRow.status,
      );
    }

    // Pick the friends-role bot with the most free capacity that is online
    // (steamid64 known). Soft capacity: a rare over-assign on a race is fine.
    const candidates = await this.postgres.query<
      Array<{ id: string; bot_steamid64: string; free: number }>
    >(
      `SELECT sa.id::text,
              sa.steamid64::text AS bot_steamid64,
              sa.friend_capacity - COUNT(f.steam_id) AS free
         FROM public.steam_accounts sa
         LEFT JOIN public.player_steam_bot_friend f
           ON f.bot_steam_account_id = sa.id
        WHERE sa.role = 'friends' AND sa.steamid64 IS NOT NULL
        GROUP BY sa.id
       HAVING sa.friend_capacity - COUNT(f.steam_id) > 0
        ORDER BY free DESC
        LIMIT 1`,
    );
    const chosen = candidates.at(0);
    if (!chosen) {
      this.logger.warn(
        "steam-presence pool has no friends-role bot with free capacity online — add/mark more accounts",
      );
      return null;
    }

    await this.postgres.query(
      `INSERT INTO public.player_steam_bot_friend
         (steam_id, bot_steam_account_id, bot_steamid64, status, updated_at)
       VALUES ($1::bigint, $2::uuid, $3::bigint, 'pending', now())
       ON CONFLICT (steam_id) DO NOTHING`,
      [steamId, chosen.id, chosen.bot_steamid64],
    );

    return SteamPresenceService.botResult(chosen.bot_steamid64, "pending");
  }

  private static botResult(
    botSteamId: string,
    status: string,
  ): { steamId: string; addUrl: string; status: string } {
    return {
      steamId: botSteamId,
      addUrl: `https://steamcommunity.com/profiles/${botSteamId}`,
      status,
    };
  }

  // ---- Phase 3: match-imported messaging ---------------------------------

  // Called (fire-and-forget) after a Valve match is imported. Sends an in-app
  // notification to every registered player in the match, and a Steam chat
  // message to those who added a bot — routed via Redis to the pod that owns
  // that bot's connection.
  public async notifyMatchImported(notice: MatchImportedNotice): Promise<void> {
    if (notice.players.length === 0 || !(await this.isEnabled())) {
      return;
    }
    const steamIds = notice.players.map((p) => p.steamId);
    const url = `${this.appConfig.webDomain}/matches/${notice.matchId}`;
    const mapLabel = notice.mapName ?? "an unknown map";
    // The stored notification message is rendered as HTML; map name and match
    // type originate from the parsed demo, so escape them before interpolation.
    const safeMap = NotificationsService.escapeHtml(mapLabel);
    const safeType = NotificationsService.escapeHtml(notice.matchType);
    const safeUrl = NotificationsService.escapeHtml(url);

    // In-app: only for registered 5stack players.
    const registered = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text FROM public.players WHERE steam_id = ANY($1::bigint[])`,
      [steamIds],
    );
    const registeredSet = new Set(registered.map((r) => r.steam_id));
    for (const player of notice.players) {
      if (!registeredSet.has(player.steamId)) {
        continue;
      }
      const message =
        `Your ${safeType} match on ${safeMap} was imported — ` +
        `you went ${player.kills}/${player.deaths}. ` +
        `<a href="${safeUrl}">View it on 5stack</a>.`;
      await this.postgres
        .query(
          `INSERT INTO public.notifications (title, message, steam_id, role, type, entity_id)
           VALUES ('Match Imported', $1, $2::bigint, 'user', 'MatchImported', $3)`,
          [message, player.steamId, notice.matchId],
        )
        .catch((err) =>
          this.logger.warn(
            `steam-presence in-app notify failed for ${player.steamId}: ${(err as Error).message}`,
          ),
        );
    }

    // Steam chat: only for players who added a bot.
    const friends = await this.postgres.query<
      Array<{ steam_id: string; bot_steam_account_id: string }>
    >(
      `SELECT steam_id::text, bot_steam_account_id::text
         FROM public.player_steam_bot_friend
        WHERE steam_id = ANY($1::bigint[])
          AND status = 'friends'
          AND bot_steam_account_id IS NOT NULL`,
      [steamIds],
    );
    if (friends.length === 0) {
      return;
    }
    const byPlayer = new Map(notice.players.map((p) => [p.steamId, p]));
    for (const friend of friends) {
      const stats = byPlayer.get(friend.steam_id);
      const text =
        `Your ${notice.matchType} match on ${mapLabel} was imported to 5stack` +
        (stats ? ` — you went ${stats.kills}/${stats.deaths}.` : ".") +
        ` ${url}`;
      await this.redis
        .publish(
          CHAT_CHANNEL,
          JSON.stringify({
            accountId: friend.bot_steam_account_id,
            steamId: friend.steam_id,
            text,
          }),
        )
        .catch(() => {});
    }
  }

  private async handleChatRequest(raw: string): Promise<void> {
    let payload: { accountId?: string; steamId?: string; text?: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload.accountId || !payload.steamId || !payload.text) {
      return;
    }
    // Only the pod that owns this bot's connection can deliver the message.
    const client = this.clients.get(payload.accountId);
    if (!client) {
      return;
    }
    client.chat.sendFriendMessage(payload.steamId, payload.text, (err) => {
      if (err) {
        this.logger.warn(
          `steam-presence chat send failed to ${payload.steamId}: ${err.message}`,
        );
      }
    });
  }

  // Submit a Steam Guard code for a bot that's awaiting one. Routed via Redis to
  // the pod holding that login's callback (any pod may receive the HTTP request).
  public async submitSteamGuard(
    accountId: string,
    code: string,
  ): Promise<{ ok: boolean }> {
    await this.redis.publish(
      GUARD_CODE_CHANNEL,
      JSON.stringify({ accountId, code }),
    );
    return { ok: true };
  }

  private async handleGuardCode(raw: string): Promise<void> {
    let payload: { accountId?: string; code?: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload.accountId || !payload.code) {
      return;
    }
    const callback = this.pendingGuards.get(payload.accountId);
    if (!callback) {
      return; // not our account (handled by the owning pod)
    }
    this.pendingGuards.delete(payload.accountId);
    callback(payload.code.trim());
    this.logger.log("steam-presence Steam Guard code submitted");
  }

  // ---- admin -------------------------------------------------------------

  // Snapshot for the admin dashboard: pool totals, per-bot rows (with live
  // cross-pod online state from Redis), and the recent-events feed.
  public async getAdminStatus(): Promise<PresenceAdminStatus> {
    const enabled = await this.isEnabled();

    const bots = await this.postgres.query<
      Array<{
        id: string;
        username: string;
        steamid64: string | null;
        steam_level: number | null;
        friend_capacity: number;
        assigned: string;
        watching: string;
      }>
    >(
      `SELECT sa.id::text,
              sa.username,
              sa.steamid64::text,
              sa.steam_level,
              sa.friend_capacity,
              COUNT(f.steam_id) AS assigned,
              COUNT(f.steam_id) FILTER (WHERE f.status = 'friends') AS watching
         FROM public.steam_accounts sa
         LEFT JOIN public.player_steam_bot_friend f
           ON f.bot_steam_account_id = sa.id
        WHERE sa.role = 'friends'
        GROUP BY sa.id
        ORDER BY sa.username`,
    );

    const onlineFlags = bots.length
      ? await this.redis.mget(bots.map((b) => ONLINE_PREFIX + b.id))
      : [];
    const guardFlags = bots.length
      ? await this.redis.mget(bots.map((b) => GUARD_PREFIX + b.id))
      : [];

    const botRows = bots.map((bot, i) => {
      let guard: { type?: "email" | "app"; lastWrong?: boolean } | null = null;
      if (guardFlags[i]) {
        try {
          guard = JSON.parse(guardFlags[i] as string);
        } catch {
          guard = null;
        }
      }
      return {
        id: bot.id,
        username: bot.username,
        steamId: bot.steamid64,
        steamLevel: bot.steam_level ?? null,
        online: onlineFlags[i] != null,
        needs2fa: guard != null,
        guardType: guard?.type ?? null,
        guardLastWrong: guard?.lastWrong === true,
        watching: Number(bot.watching),
        assigned: Number(bot.assigned),
        capacity: bot.friend_capacity,
      };
    });

    return {
      enabled,
      pool: {
        bots: botRows.length,
        online: botRows.filter((b) => b.online).length,
        watching: botRows.reduce((sum, b) => sum + b.watching, 0),
        pending: botRows.reduce(
          (sum, b) => sum + (b.assigned - b.watching),
          0,
        ),
        capacity: botRows.reduce((sum, b) => sum + b.capacity, 0),
      },
      bots: botRows,
    };
  }

  // Add a dedicated friends-role bot account to the pool. The next sync tick
  // logs it in (across whichever pod claims it). Returns the new account id.
  public async addFriendsAccount(
    username: string,
    password: string,
    friendCapacity = 250,
  ): Promise<{ id: string }> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.steam_accounts (username, password, role, friend_capacity)
       VALUES ($1, $2, 'friends', $3)
       ON CONFLICT (username) DO NOTHING
       RETURNING id::text`,
      [username, password, friendCapacity],
    );
    const id = rows.at(0)?.id;
    if (!id) {
      throw new Error("a steam account with that username already exists");
    }
    return { id };
  }

  // Remove a friends-role bot account. Guarded to friends-role so this can never
  // delete a GPU pool account. The sync tick tears down its live connection.
  public async removeFriendsAccount(id: string): Promise<{ ok: boolean }> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `DELETE FROM public.steam_accounts
        WHERE id = $1::uuid AND role = 'friends'
        RETURNING id::text`,
      [id],
    );
    return { ok: rows.length > 0 };
  }
}
