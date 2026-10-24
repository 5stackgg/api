import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { HasuraService } from "src/hasura/hasura.service";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { FiveStackWebSocketClient } from "./types/FiveStackWebSocketClient";
import { latencyTestKey, playerClientKey, playerKey } from "./presence-keys";

// What the LAN and online lists show for each player; every field is readable
// by guests.
const PROFILE_FIELDS = {
  steam_id: true,
  name: true,
  role: true,
  country: true,
  avatar_url: true,
  custom_avatar_url: true,
  roster_image_url: true,
  is_banned: true,
  is_gagged: true,
  is_muted: true,
  vac_banned: true,
  vac_ban_count: true,
  game_ban_count: true,
  days_since_last_ban: true,
  premier_rank: true,
  premier_rank_updated_at: true,
  faceit_skill_level: true,
  faceit_elo: true,
  faceit_url: true,
  faceit_nickname: true,
  elo: true,
  allow_message_requests: true,
} as const;

export type PresenceProfile = { steam_id: string } & Record<string, unknown>;

// Who is online goes to the people it concerns: a player's circle (friends and
// teammates) hears when they come and go, a LAN hears about its own players,
// and everyone else gets the count, plus the list of everyone while it is short
// enough to list.
@Injectable()
export class PresenceService implements OnApplicationShutdown {
  public static readonly ONLINE = "presence:online";
  public static readonly LAN_REGIONS = "presence:lan-regions";
  public static readonly LISTED = "presence:listed";
  public static readonly CHECK_LIMIT = 50;
  public static readonly COUNT_INTERVAL_MS = 5_000;
  public static readonly PAGE_SIZE = 25;
  public static readonly LIST_MAX_DEFAULT = 200;
  private static readonly LIST_MAX_TTL_MS = 30_000;
  private static readonly QUERY_MAX_LENGTH = 64;
  private static readonly CIRCLE_TTL_SECONDS = 3 * 60;
  private static readonly PROFILE_TTL_SECONDS = 2 * 60;

  private redis: Redis;
  private countTimer?: NodeJS.Timeout;
  private countPending = false;
  private listMax?: { value: number; readAt: number };

  constructor(
    private readonly logger: Logger,
    redisManager: RedisManagerService,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
  ) {
    this.redis = redisManager.getConnection();
  }

  public static CIRCLE_KEY(steamId: string) {
    return `presence:circle:${steamId}`;
  }

  public static LAN_PLAYERS_KEY(region: string) {
    return `presence:lan:${region}`;
  }

  public static LAN_CLIENTS_KEY(region: string, steamId: string) {
    return `presence:lan:${region}:${steamId}`;
  }

  public static PROFILE_KEY(steamId: string) {
    return `presence:profile:${steamId}`;
  }

  public onApplicationShutdown() {
    clearTimeout(this.countTimer);
  }

  public async cameOnline(steamId: string) {
    const added = await this.redis.zadd(
      PresenceService.ONLINE,
      Date.now(),
      String(steamId),
    );
    if (!added) {
      return;
    }

    this.countChanged();
    await this.notifyCircle(String(steamId), true);
    await this.notifyWatchers(String(steamId), true);
  }

  public async wentOffline(steamId: string) {
    const removed = await this.redis.zrem(
      PresenceService.ONLINE,
      String(steamId),
    );
    if (!removed) {
      return;
    }

    this.countChanged();
    await this.notifyCircle(String(steamId), false);
    await this.notifyWatchers(String(steamId), false);
  }

  public async welcome(client: FiveStackWebSocketClient) {
    const count = await this.redis.zcard(PresenceService.ONLINE);
    this.send(client, "players-online:count", count);
    this.send(client, "players-online:listed", await this.listed(count));
    await this.sendFriendsOnline(client, false);
  }

  public async sendFriendsOnline(
    client: FiveStackWebSocketClient,
    fresh = true,
  ) {
    const circle = await this.circle(String(client.user.steam_id), fresh);
    this.send(client, "friends-online", await this.online(circle));
  }

  public async check(
    client: FiveStackWebSocketClient,
    data: { requestId?: unknown; steamIds?: unknown },
  ) {
    if (!Array.isArray(data?.steamIds)) {
      return;
    }

    const steamIds = [...new Set(data.steamIds.map(String))].slice(
      0,
      PresenceService.CHECK_LIMIT,
    );

    this.send(client, "players-online:check", {
      requestId: data.requestId,
      online: await this.online(steamIds),
    });
  }

  // Everyone online but the asker, newest first, a page at a time. The cursor is
  // the last row's place in that order rather than an offset, so players coming
  // and going between pages never repeat or skip anyone.
  public async page(
    client: FiveStackWebSocketClient,
    data: { requestId?: unknown; after?: unknown; query?: unknown },
  ) {
    const reply = (
      listed: boolean,
      players: PresenceProfile[] = [],
      next: string | null = null,
    ) =>
      this.send(client, "players-online:page", {
        requestId: data?.requestId,
        listed,
        players,
        next,
      });

    if (!(await this.listed())) {
      reply(false);
      return;
    }

    const me = String(client.user.steam_id);
    const scores = await this.redis.zrevrange(
      PresenceService.ONLINE,
      0,
      -1,
      "WITHSCORES",
    );
    const [afterScore, afterSteamId] =
      typeof data?.after === "string" ? data.after.split(":") : [];
    const rows: Array<{ steamId: string; score: number }> = [];
    for (let index = 0; index < scores.length; index += 2) {
      const row = { steamId: scores[index], score: Number(scores[index + 1]) };
      const isAfter =
        afterScore === undefined ||
        row.score < Number(afterScore) ||
        (row.score === Number(afterScore) && row.steamId < afterSteamId);
      if (row.steamId !== me && isAfter) {
        rows.push(row);
      }
    }

    const query =
      typeof data?.query === "string"
        ? data.query
            .trim()
            .toLowerCase()
            .slice(0, PresenceService.QUERY_MAX_LENGTH)
        : "";

    let players: PresenceProfile[];
    let more: boolean;
    if (query) {
      const matches = (
        await this.profiles(rows.map(({ steamId }) => steamId))
      ).filter(
        (player) =>
          String(player.name ?? "")
            .toLowerCase()
            .includes(query) || player.steam_id.includes(query),
      );
      players = matches.slice(0, PresenceService.PAGE_SIZE);
      more = matches.length > players.length;
    } else {
      const page = rows.slice(0, PresenceService.PAGE_SIZE);
      players = await this.profiles(page.map(({ steamId }) => steamId));
      more = rows.length > page.length;
    }

    const last = rows.find(
      ({ steamId }) => steamId === players.at(-1)?.steam_id,
    );
    reply(true, players, more && last ? `${last.score}:${last.steamId}` : null);
  }

  public watch(client: FiveStackWebSocketClient, data: { watching?: unknown }) {
    client.watchingOnline = data?.watching === true;
  }

  // A tab's LAN can change under it (the probe runs again, the laptop moves),
  // so this runs on connect and on every ping. One tab's changes run in order.
  public syncLan(client: FiveStackWebSocketClient) {
    return this.queueLan(client, async () => {
      if (client.lanClosed) {
        return;
      }

      const region = await this.lanRegion(client.sessionId);
      if (region === (client.lanRegion ?? null)) {
        return;
      }

      if (client.lanRegion) {
        await this.leaveLanRegion(
          client.lanRegion,
          String(client.user.steam_id),
          this.lanMember(client),
        );
      }

      client.lanRegion = region;

      if (region) {
        await this.joinLanRegion(region, client);
      }

      this.send(client, "lan-roster", {
        region,
        players: region ? await this.lanPlayers(region) : [],
      });
    });
  }

  public leaveLan(client: FiveStackWebSocketClient) {
    client.lanClosed = true;

    return this.queueLan(client, async () => {
      if (!client.lanRegion) {
        return;
      }

      const region = client.lanRegion;
      client.lanRegion = null;
      await this.leaveLanRegion(
        region,
        String(client.user.steam_id),
        this.lanMember(client),
      );
    });
  }

  // Players and tabs whose presence expired without a close: a pod that died,
  // a tab the browser froze.
  public async sweep() {
    const online = await this.redis.zrange(PresenceService.ONLINE, 0, -1);
    const present = await this.exists(
      online.map((steamId) => playerKey(steamId)),
    );
    for (const [index, steamId] of online.entries()) {
      if (!present[index]) {
        await this.wentOffline(steamId);
      }
    }

    for (const region of await this.redis.smembers(
      PresenceService.LAN_REGIONS,
    )) {
      const players = await this.redis.smembers(
        PresenceService.LAN_PLAYERS_KEY(region),
      );
      if (players.length === 0) {
        await this.redis.srem(PresenceService.LAN_REGIONS, region);
        continue;
      }

      for (const steamId of players) {
        const members = await this.redis.smembers(
          PresenceService.LAN_CLIENTS_KEY(region, steamId),
        );
        const live = await this.exists(
          members.map((member) => {
            const [nodeId, clientId] = member.split("|");
            return playerClientKey(steamId, nodeId, clientId);
          }),
        );
        for (const [index, member] of members.entries()) {
          if (!live[index]) {
            await this.leaveLanRegion(region, steamId, member);
          }
        }
        if (members.length === 0) {
          await this.redis.srem(
            PresenceService.LAN_PLAYERS_KEY(region),
            steamId,
          );
          await this.publishLan(region, {
            region,
            joined: [],
            left: [steamId],
          });
        }
      }
    }
  }

  private queueLan(
    client: FiveStackWebSocketClient,
    work: () => Promise<void>,
  ) {
    client.lanQueue = (client.lanQueue ?? Promise.resolve())
      .then(work)
      .catch((error) => {
        this.logger.warn(
          `unable to update the LAN of ${client.user?.steam_id}`,
          error,
        );
      });

    return client.lanQueue;
  }

  private lanMember(client: FiveStackWebSocketClient) {
    return `${client.node}|${client.id}`;
  }

  // The LAN this session's probe found, the closest one when it found several.
  private async lanRegion(sessionId: string): Promise<string | null> {
    const results = await this.redis.hgetall(latencyTestKey(sessionId));

    let best: { region: string; latency: number } | null = null;
    for (const value of Object.values(results ?? {})) {
      let result: { region?: string; latency?: number; isLan?: boolean };
      try {
        result = JSON.parse(value);
      } catch {
        continue;
      }
      if (result?.isLan !== true || !result.region) {
        continue;
      }
      const latency = Number(result.latency ?? Infinity);
      if (!best || latency < best.latency) {
        best = { region: result.region, latency };
      }
    }

    return best?.region ?? null;
  }

  private async joinLanRegion(
    region: string,
    client: FiveStackWebSocketClient,
  ) {
    const steamId = String(client.user.steam_id);
    const clientsKey = PresenceService.LAN_CLIENTS_KEY(region, steamId);
    const [[, added], [, clients]] = (await this.redis
      .multi()
      .sadd(clientsKey, this.lanMember(client))
      .scard(clientsKey)
      .exec()) as Array<[Error | null, number]>;

    if (!added || clients !== 1) {
      return;
    }

    await this.redis
      .multi()
      .sadd(PresenceService.LAN_PLAYERS_KEY(region), steamId)
      .sadd(PresenceService.LAN_REGIONS, region)
      .exec();

    await this.publishLan(region, {
      region,
      joined: await this.profiles([steamId]),
      left: [],
    });
  }

  private async leaveLanRegion(
    region: string,
    steamId: string,
    member: string,
  ) {
    const clientsKey = PresenceService.LAN_CLIENTS_KEY(region, steamId);
    const [[, removed], [, remaining]] = (await this.redis
      .multi()
      .srem(clientsKey, member)
      .scard(clientsKey)
      .exec()) as Array<[Error | null, number]>;

    if (!removed || remaining > 0) {
      return;
    }

    await this.redis.srem(PresenceService.LAN_PLAYERS_KEY(region), steamId);
    await this.publishLan(region, { region, joined: [], left: [steamId] });
  }

  private async lanPlayers(region: string) {
    const steamIds = await this.redis.smembers(
      PresenceService.LAN_PLAYERS_KEY(region),
    );
    return this.profiles(steamIds.sort());
  }

  private async publishLan(
    region: string,
    data: { region: string; joined: PresenceProfile[]; left: string[] },
  ) {
    await this.redis.publish(
      "lan-message",
      JSON.stringify({ region, event: "lan-presence", data }),
    );
  }

  // Friends either way round, whatever the status, and everyone on a team the
  // player is on.
  private async circle(steamId: string, fresh: boolean): Promise<string[]> {
    const key = PresenceService.CIRCLE_KEY(steamId);
    if (!fresh) {
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const { friends, team_roster } = await this.hasura.query({
      friends: {
        __args: {
          where: {
            _or: [
              { player_steam_id: { _eq: steamId } },
              { other_player_steam_id: { _eq: steamId } },
            ],
          },
        },
        player_steam_id: true,
        other_player_steam_id: true,
      },
      team_roster: {
        __args: {
          where: {
            team: { roster: { player_steam_id: { _eq: steamId } } },
          },
        },
        player_steam_id: true,
      },
    });

    const members = new Set<string>();
    for (const friend of friends) {
      members.add(String(friend.player_steam_id));
      members.add(String(friend.other_player_steam_id));
    }
    for (const teammate of team_roster) {
      members.add(String(teammate.player_steam_id));
    }
    members.delete(steamId);

    const circle = [...members].sort();
    await this.redis.set(
      key,
      JSON.stringify(circle),
      "EX",
      PresenceService.CIRCLE_TTL_SECONDS,
    );

    return circle;
  }

  private async notifyCircle(steamId: string, online: boolean) {
    try {
      for (const member of await this.online(
        await this.circle(steamId, false),
      )) {
        await this.redis.publish(
          "send-message-to-steam-id",
          JSON.stringify({
            steamId: member,
            event: "friend-presence",
            data: { steam_id: steamId, online },
          }),
        );
      }
    } catch (error) {
      this.logger.warn(
        `unable to tell ${steamId}'s friends they came or went`,
        error,
      );
    }
  }

  private async notifyWatchers(steamId: string, online: boolean) {
    try {
      if (!(await this.listed())) {
        return;
      }

      await this.redis.publish(
        "online-message",
        JSON.stringify({
          event: "online-presence",
          data: { steam_id: steamId, online },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `unable to tell the online list ${steamId} came or went`,
        error,
      );
    }
  }

  // Once over the limit the list only comes back 10% under it, so a count
  // hovering at the limit doesn't switch it on and off with every arrival.
  // Tabs hear only when it switches; a connecting tab is told in welcome.
  private async listed(count?: number) {
    const max = await this.listMaxSetting();
    const online = count ?? (await this.redis.zcard(PresenceService.ONLINE));
    const wasListed = (await this.redis.get(PresenceService.LISTED)) !== "0";
    const listed =
      max > 0 && online <= (wasListed ? max : Math.floor(max * 0.9));
    if (listed !== wasListed) {
      await this.redis.set(PresenceService.LISTED, listed ? "1" : "0");
      await this.redis.publish(
        "broadcast-message",
        JSON.stringify({ event: "players-online:listed", data: listed }),
      );
    }

    return listed;
  }

  // Read on every arrival and departure, so it is kept for a while rather than
  // asked of postgres each time.
  private async listMaxSetting() {
    if (
      this.listMax &&
      Date.now() - this.listMax.readAt < PresenceService.LIST_MAX_TTL_MS
    ) {
      return this.listMax.value;
    }

    let value = PresenceService.LIST_MAX_DEFAULT;
    try {
      const [row] = await this.postgres.query<Array<{ value: string }>>(
        `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
        [SystemSettingName.OnlineListMax],
      );
      value = PresenceService.listMaxFrom(row?.value);
    } catch (error) {
      this.logger.warn("unable to read the online list limit", error);
    }

    this.listMax = { value, readAt: Date.now() };
    return value;
  }

  public static listMaxFrom(value?: string | null) {
    if (value === undefined || value === null || value.trim() === "") {
      return PresenceService.LIST_MAX_DEFAULT;
    }

    const max = Number(value);
    return Number.isFinite(max) && max >= 0
      ? Math.floor(max)
      : PresenceService.LIST_MAX_DEFAULT;
  }

  private async online(steamIds: Array<string>) {
    if (steamIds.length === 0) {
      return [];
    }

    const scores = await this.redis.zmscore(
      PresenceService.ONLINE,
      ...steamIds,
    );
    return steamIds.filter((_, index) => scores[index] !== null);
  }

  private async exists(keys: Array<string>): Promise<boolean[]> {
    if (keys.length === 0) {
      return [];
    }

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.exists(key);
    }
    const results = (await pipeline.exec()) ?? [];
    return results.map(([, count]) => Number(count) > 0);
  }

  // Leading and trailing: the first change goes out at once, the rest of a
  // burst once the interval is up.
  private countChanged() {
    if (this.countTimer) {
      this.countPending = true;
      return;
    }

    void this.publishCount();
    this.countTimer = setTimeout(
      () => this.countTick(),
      PresenceService.COUNT_INTERVAL_MS,
    );
  }

  private countTick() {
    this.countTimer = undefined;
    if (!this.countPending) {
      return;
    }

    this.countPending = false;
    this.countChanged();
  }

  private async publishCount() {
    try {
      await this.redis.publish(
        "broadcast-message",
        JSON.stringify({
          event: "players-online:count",
          data: await this.redis.zcard(PresenceService.ONLINE),
        }),
      );
    } catch (error) {
      this.logger.warn("unable to send the online count", error);
    }
  }

  private async profiles(steamIds: Array<string>): Promise<PresenceProfile[]> {
    if (steamIds.length === 0) {
      return [];
    }

    try {
      const cached = await this.redis.mget(
        steamIds.map((steamId) => PresenceService.PROFILE_KEY(steamId)),
      );
      const bySteamId = new Map<string, PresenceProfile>();
      steamIds.forEach((steamId, index) => {
        if (cached[index]) {
          bySteamId.set(steamId, JSON.parse(cached[index]));
        }
      });

      const missing = steamIds.filter((steamId) => !bySteamId.has(steamId));
      if (missing.length > 0) {
        const { players } = await this.hasura.query({
          players: {
            __args: { where: { steam_id: { _in: missing } } },
            ...PROFILE_FIELDS,
          },
        });
        for (const player of players) {
          const profile = { ...player, steam_id: String(player.steam_id) };
          bySteamId.set(profile.steam_id, profile);
          await this.redis.set(
            PresenceService.PROFILE_KEY(profile.steam_id),
            JSON.stringify(profile),
            "EX",
            PresenceService.PROFILE_TTL_SECONDS,
          );
        }
      }

      return steamIds
        .map((steamId) => bySteamId.get(steamId))
        .filter((profile): profile is PresenceProfile => !!profile);
    } catch (error) {
      this.logger.warn("unable to load player profiles", error);
      return [];
    }
  }

  private send(client: FiveStackWebSocketClient, event: string, data: unknown) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  }
}
