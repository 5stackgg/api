import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import Redis from "ioredis";
import { User } from "src/auth/types/User";
import { PostgresService } from "src/postgres/postgres.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { ServerRosterService } from "./server-roster.service";

export type CommunityPeriod = "week" | "all";
export type CommunityMetric = "time" | "kills";

type BoardRow = {
  steam_id: string;
  name: string;
  avatar_url: string | null;
  country: string | null;
  seconds: number;
  kills: number;
  deaths: number;
  sessions: number;
};

type RankedRow = BoardRow & { rank: number };

type BoardKeys = {
  time: string;
  kills: string;
  rows: string;
  lock: string;
  failed: string;
};

type Totals = {
  sessions: number;
  seconds: number;
  kills: number;
  deaths: number;
  servers: number;
  rank: number | null;
};

type VisibleServer = {
  id: string;
  label: string;
  max_players: number | null;
};

@Injectable()
export class CommunityStatsService {
  private static readonly BOARD_TTL_SECONDS = 120;
  private static readonly LOCK_SECONDS = 30;
  private static readonly FAILURE_SECONDS = 30;
  private static readonly WAIT_ATTEMPTS = 40;
  private static readonly WAIT_MS = 150;
  private static readonly ZADD_CHUNK = 1000;
  private static readonly RELEASE_LOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;
  private static readonly SERVER_STATS_TTL_SECONDS = 300;
  private static readonly PLAYER_STATS_TTL_SECONDS = 60;
  private static readonly HOURS = 168;
  private static readonly MAX_LIMIT = 50;
  private static readonly DEFAULT_LIMIT = 10;
  private static readonly HOUR_MS = 60 * 60 * 1000;

  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly roster: ServerRosterService,
    redisManager: RedisManagerService,
  ) {
    this.redis = redisManager.getConnection();
  }

  public async serverStats(serverId: string, user?: User) {
    const server = await this.visibleServer(serverId, user);

    if (!server) {
      return null;
    }

    const stats = await this.cached(
      `community:server:${serverId}:${await this.roster.version(serverId)}`,
      CommunityStatsService.SERVER_STATS_TTL_SECONDS,
      () => this.loadServerStats(serverId),
    );

    if (!stats) {
      return null;
    }

    const live = await this.roster.liveCounts();

    return {
      ...stats,
      server_id: serverId,
      max_players: server.max_players,
      online: live[serverId] ?? stats.online,
    };
  }

  public async leaderboard(
    serverId: string,
    period: string,
    metric: string,
    limit: number | null | undefined,
    user?: User,
  ) {
    const empty: { entries: Array<RankedRow>; you: RankedRow | null } = {
      entries: [],
      you: null,
    };

    if (
      !CommunityStatsService.isPeriod(period) ||
      !CommunityStatsService.isMetric(metric)
    ) {
      return empty;
    }

    if (!(await this.visibleServer(serverId, user))) {
      return empty;
    }

    const keys = await this.ensureBoard(serverId, period);

    if (!keys) {
      return empty;
    }

    const scoreKey = metric === "time" ? keys.time : keys.kills;
    const size = Math.min(
      Math.max(Math.floor(limit ?? CommunityStatsService.DEFAULT_LIMIT), 1),
      CommunityStatsService.MAX_LIMIT,
    );

    const steamIds = await this.redis.zrevrange(scoreKey, 0, size - 1);
    const rows =
      steamIds.length > 0 ? await this.redis.hmget(keys.rows, ...steamIds) : [];

    const entries = rows
      .map((row, index): RankedRow | null => {
        if (!row) {
          return null;
        }
        return { rank: index + 1, ...(JSON.parse(row) as BoardRow) };
      })
      .filter((entry): entry is RankedRow => {
        return entry !== null;
      });

    let you: RankedRow | null = null;

    if (user?.steam_id) {
      const rank = await this.redis.zrevrank(scoreKey, user.steam_id);
      const row =
        rank === null ? null : await this.redis.hget(keys.rows, user.steam_id);

      if (rank !== null && row) {
        you = { rank: rank + 1, ...(JSON.parse(row) as BoardRow) };
      }
    }

    return { entries, you };
  }

  public async playerStats(steamId: string, user?: User) {
    if (!/^\d{1,18}$/.test(String(steamId))) {
      return null;
    }

    const moderator = !!user && isRoleAbove(user.role, "moderator");

    return await this.cached(
      `community:player:${steamId}:${moderator ? "moderator" : "public"}`,
      CommunityStatsService.PLAYER_STATS_TTL_SECONDS,
      () => this.loadPlayerStats(String(steamId), moderator),
    );
  }

  // The same rule that lists a server publicly (get_server_connection_string),
  // minus the online check so the numbers survive a restart: never Ranked or
  // Practice, restricted servers only for the players they let in, and a
  // password-protected server only for the roles allowed to connect to it.
  // Moderators see every dedicated server.
  private async visibleServer(
    serverId: string,
    user?: User,
  ): Promise<VisibleServer | null> {
    if (!/^[0-9a-f-]{36}$/i.test(String(serverId))) {
      return null;
    }

    const [server] = await this.postgres.query<Array<VisibleServer>>(
      `SELECT s.id, s.label, s.max_players
         FROM public.servers s
        WHERE s.id = $1
          AND s.is_dedicated
          AND (
              public.is_above_role('moderator', $2::json)
              OR (
                  s.type NOT IN ('Ranked', 'Practice')
                  AND public.can_connect_to_server(s, $2::json)
                  AND (
                      NULLIF(s.connect_password, '') IS NULL
                      OR public.is_above_role(
                          public.get_setting('dedicated_servers_min_role_to_connect', 'user'),
                          $2::json
                      )
                  )
              )
          )`,
      [serverId, CommunityStatsService.session(user)],
    );

    return server ?? null;
  }

  private async loadServerStats(serverId: string) {
    const [week] = await this.postgres.query<
      Array<{ week_players: number; week_seconds: number; online: number }>
    >(
      `SELECT count(DISTINCT player_steam_id)::int AS week_players,
              coalesce(sum(extract(epoch FROM coalesce(ended_at, now())
                                     - greatest(started_at, now() - interval '7 days'))), 0)::int AS week_seconds,
              (count(*) FILTER (WHERE ended_at IS NULL))::int AS online
         FROM public.server_player_sessions
        WHERE server_id = $1
          AND coalesce(ended_at, now()) > now() - interval '7 days'`,
      [serverId],
    );

    const [allTime] = await this.postgres.query<
      Array<{ all_time_players: number; tracked_since: Date | null }>
    >(
      `SELECT count(*)::int AS all_time_players,
              min(first_seen_at) AS tracked_since
         FROM public.v_server_player_totals
        WHERE server_id = $1`,
      [serverId],
    );

    const hourly = await this.postgres.query<
      Array<{ hour: Date; seconds: number; players: number }>
    >(
      `SELECT hour, seconds, players
         FROM public.server_hourly_activity($1, $2)`,
      [serverId, CommunityStatsService.HOURS],
    );

    return {
      online: week?.online ?? 0,
      week_players: week?.week_players ?? 0,
      week_seconds: week?.week_seconds ?? 0,
      all_time_players: allTime?.all_time_players ?? 0,
      tracked_since: allTime?.tracked_since
        ? new Date(allTime.tracked_since).toISOString()
        : null,
      hourly: hourly.map((bucket) => ({
        hour: new Date(bucket.hour).toISOString(),
        seconds: bucket.seconds,
        players: bucket.players,
      })),
    };
  }

  // One aggregate per server and period every two minutes at most, however
  // many people have the page open: the board lives in Redis sorted sets and
  // whoever finds it missing rebuilds it under a lock. A failed build is
  // remembered for a moment so a query that times out under load is not
  // retried by every request behind it.
  private async ensureBoard(
    serverId: string,
    period: CommunityPeriod,
  ): Promise<BoardKeys | null> {
    const keys = CommunityStatsService.boardKeys(
      serverId,
      period,
      await this.roster.version(serverId),
    );

    if (await this.redis.exists(keys.rows)) {
      return keys;
    }

    if (await this.redis.exists(keys.failed)) {
      return null;
    }

    const token = randomUUID();
    const locked = await this.redis.set(
      keys.lock,
      token,
      "EX",
      CommunityStatsService.LOCK_SECONDS,
      "NX",
    );

    if (!locked) {
      return (await this.waitFor(keys.rows, keys.failed)) ? keys : null;
    }

    try {
      const rows = await this.loadBoard(serverId, period);
      const multi = this.redis.multi().del(keys.time, keys.kills, keys.rows);

      for (
        let start = 0;
        start < rows.length;
        start += CommunityStatsService.ZADD_CHUNK
      ) {
        const chunk = rows.slice(
          start,
          start + CommunityStatsService.ZADD_CHUNK,
        );

        multi.zadd(
          keys.time,
          ...chunk.flatMap((row) => [row.seconds, row.steam_id]),
        );
        multi.zadd(
          keys.kills,
          ...chunk.flatMap((row) => [row.kills, row.steam_id]),
        );
        multi.hset(
          keys.rows,
          Object.fromEntries(
            chunk.map((row) => [row.steam_id, JSON.stringify(row)]),
          ),
        );
      }

      if (rows.length === 0) {
        multi.hset(keys.rows, "_empty", "1");
      }

      multi
        .expire(keys.time, CommunityStatsService.BOARD_TTL_SECONDS)
        .expire(keys.kills, CommunityStatsService.BOARD_TTL_SECONDS)
        .expire(keys.rows, CommunityStatsService.BOARD_TTL_SECONDS);

      await multi.exec();

      return keys;
    } catch (error) {
      this.logger.warn(
        `[${serverId}] unable to build the ${period} leaderboard: ${(error as Error)?.message ?? error}`,
      );
      await this.redis.set(
        keys.failed,
        "1",
        "EX",
        CommunityStatsService.FAILURE_SECONDS,
      );
      return null;
    } finally {
      await this.release(keys.lock, token);
    }
  }

  // The same single-flight for one cached JSON value.
  private async cached<T>(
    key: string,
    ttlSeconds: number,
    load: () => Promise<T>,
  ): Promise<T | null> {
    const hit = await this.redis.get(key);

    if (hit) {
      return JSON.parse(hit) as T;
    }

    if (await this.redis.exists(`${key}:failed`)) {
      return null;
    }

    const token = randomUUID();
    const locked = await this.redis.set(
      `${key}:lock`,
      token,
      "EX",
      CommunityStatsService.LOCK_SECONDS,
      "NX",
    );

    if (!locked) {
      if (!(await this.waitFor(key, `${key}:failed`))) {
        return null;
      }
      const value = await this.redis.get(key);
      return value ? (JSON.parse(value) as T) : null;
    }

    try {
      const value = await load();

      await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);

      return value;
    } catch (error) {
      this.logger.warn(
        `unable to load ${key}: ${(error as Error)?.message ?? error}`,
      );
      await this.redis.set(
        `${key}:failed`,
        "1",
        "EX",
        CommunityStatsService.FAILURE_SECONDS,
      );
      return null;
    } finally {
      await this.release(`${key}:lock`, token);
    }
  }

  private async waitFor(key: string, failedKey: string): Promise<boolean> {
    for (
      let attempt = 0;
      attempt < CommunityStatsService.WAIT_ATTEMPTS;
      attempt++
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, CommunityStatsService.WAIT_MS),
      );

      if (await this.redis.exists(key)) {
        return true;
      }

      if (await this.redis.exists(failedKey)) {
        return false;
      }
    }

    return false;
  }

  // Only the holder deletes the lock: a build that outlived the lock's TTL
  // must not release the next builder's.
  private async release(lockKey: string, token: string): Promise<void> {
    await this.redis.eval(
      CommunityStatsService.RELEASE_LOCK,
      1,
      lockKey,
      token,
    );
  }

  // Only players who have signed in to 5stack are ranked; a players row alone
  // can be someone imported from a match who never signed up. Everyone still
  // counts toward the server's totals.
  private async loadBoard(
    serverId: string,
    period: CommunityPeriod,
  ): Promise<Array<BoardRow>> {
    if (period === "week") {
      return await this.postgres.query<Array<BoardRow>>(
        `SELECT s.player_steam_id::text AS steam_id,
                p.name,
                p.avatar_url,
                p.country,
                sum(extract(epoch FROM coalesce(s.ended_at, now())
                               - greatest(s.started_at, now() - interval '7 days')))::int AS seconds,
                sum(s.kills)::int AS kills,
                sum(s.deaths)::int AS deaths,
                count(*)::int AS sessions
           FROM public.server_player_sessions s
           JOIN public.players p
             ON p.steam_id = s.player_steam_id
            AND p.last_sign_in_at IS NOT NULL
          WHERE s.server_id = $1
            AND coalesce(s.ended_at, now()) > now() - interval '7 days'
          GROUP BY s.player_steam_id, p.name, p.avatar_url, p.country`,
        [serverId],
      );
    }

    return await this.postgres.query<Array<BoardRow>>(
      `SELECT t.player_steam_id::text AS steam_id,
              p.name,
              p.avatar_url,
              p.country,
              least(t.seconds_played, 2147483647)::int AS seconds,
              t.kills,
              t.deaths,
              t.sessions
         FROM public.v_server_player_totals t
         JOIN public.players p
           ON p.steam_id = t.player_steam_id
          AND p.last_sign_in_at IS NOT NULL
        WHERE t.server_id = $1`,
      [serverId],
    );
  }

  private async loadPlayerStats(steamId: string, moderator: boolean) {
    const servers = await this.postgres.query<
      Array<{
        server_id: string;
        label: string;
        region: string | null;
        type: string | null;
        online: boolean;
        last_seen_at: Date;
        week_sessions: number;
        week_seconds: number;
        week_kills: number;
        week_deaths: number;
        all_sessions: number;
        all_seconds: number;
        all_kills: number;
        all_deaths: number;
      }>
    >(
      `WITH week AS (
          SELECT server_id,
                 count(*)::int AS sessions,
                 sum(extract(epoch FROM coalesce(ended_at, now())
                                - greatest(started_at, now() - interval '7 days')))::int AS seconds,
                 sum(kills)::int AS kills,
                 sum(deaths)::int AS deaths,
                 bool_or(ended_at IS NULL) AS online
            FROM public.server_player_sessions
           WHERE player_steam_id = $1
             AND coalesce(ended_at, now()) > now() - interval '7 days'
           GROUP BY server_id
       )
       SELECT t.server_id,
              sv.label,
              sv.region,
              sv.type::text AS type,
              coalesce(w.online, false) AS online,
              t.last_seen_at,
              coalesce(w.sessions, 0) AS week_sessions,
              coalesce(w.seconds, 0) AS week_seconds,
              coalesce(w.kills, 0) AS week_kills,
              coalesce(w.deaths, 0) AS week_deaths,
              t.sessions AS all_sessions,
              least(t.seconds_played, 2147483647)::int AS all_seconds,
              t.kills AS all_kills,
              t.deaths AS all_deaths
         FROM public.v_server_player_totals t
         JOIN public.servers sv ON sv.id = t.server_id
         LEFT JOIN week w ON w.server_id = t.server_id
        WHERE t.player_steam_id = $1
          AND (
              $2::boolean
              OR (
                  sv.type NOT IN ('Ranked', 'Practice')
                  AND NOT sv.access_restricted
                  AND (
                      NULLIF(sv.connect_password, '') IS NULL
                      OR public.is_above_role(
                          public.get_setting('dedicated_servers_min_role_to_connect', 'user'),
                          '{"x-hasura-role": "guest"}'::json
                      )
                  )
              )
          )
        ORDER BY coalesce(w.online, false) DESC, t.last_seen_at DESC`,
      [steamId, moderator],
    );

    const ranks = await this.ranks(
      steamId,
      servers.map((server) => server.server_id),
    );

    const names = moderator ? await this.namesUsed(steamId) : null;
    const sessions = moderator ? await this.recentSessions(steamId) : null;

    const totals = (period: "week" | "all"): Totals => {
      const played = servers.filter((server) => {
        return period === "all" || server.week_sessions > 0;
      });
      return {
        sessions: played.reduce(
          (sum, server) => sum + server[`${period}_sessions`],
          0,
        ),
        seconds: played.reduce(
          (sum, server) => sum + server[`${period}_seconds`],
          0,
        ),
        kills: played.reduce(
          (sum, server) => sum + server[`${period}_kills`],
          0,
        ),
        deaths: played.reduce(
          (sum, server) => sum + server[`${period}_deaths`],
          0,
        ),
        servers: played.length,
        rank: null,
      };
    };

    const online = servers.find((server) => server.online);
    const lastSeen = servers.reduce<Date | null>((latest, server) => {
      const seen = new Date(server.last_seen_at);
      return !latest || seen > latest ? seen : latest;
    }, null);

    return {
      is_moderator_view: moderator,
      week: totals("week"),
      all_time: totals("all"),
      last_seen_at: this.lastSeen(lastSeen, moderator),
      online_server_id: online?.server_id ?? null,
      online_server_label: online?.label ?? null,
      servers: servers.map((server) => ({
        server_id: server.server_id,
        label: server.label,
        region: server.region,
        type: server.type,
        online: server.online,
        last_seen_at: this.lastSeen(new Date(server.last_seen_at), moderator),
        week: {
          sessions: server.week_sessions,
          seconds: server.week_seconds,
          kills: server.week_kills,
          deaths: server.week_deaths,
          servers: server.week_sessions > 0 ? 1 : 0,
          rank: ranks.get(`${server.server_id}:week`) ?? null,
        },
        all_time: {
          sessions: server.all_sessions,
          seconds: server.all_seconds,
          kills: server.all_kills,
          deaths: server.all_deaths,
          servers: 1,
          rank: ranks.get(`${server.server_id}:all`) ?? null,
        },
        names: names ? (names.get(server.server_id) ?? []) : null,
        sessions: sessions ? (sessions.get(server.server_id) ?? []) : null,
      })),
      ips: moderator ? await this.ipsUsed(steamId) : null,
      ip_matches: moderator ? await this.ipMatches(steamId) : null,
    };
  }

  // Everyone but moderators gets the hour, not the minute: enough to say "2h
  // ago" without publishing exactly when someone was playing.
  private lastSeen(seen: Date | null, moderator: boolean): string | null {
    if (!seen) {
      return null;
    }

    if (moderator) {
      return seen.toISOString();
    }

    return new Date(
      Math.floor(seen.getTime() / CommunityStatsService.HOUR_MS) *
        CommunityStatsService.HOUR_MS,
    ).toISOString();
  }

  private async ranks(
    steamId: string,
    serverIds: Array<string>,
  ): Promise<Map<string, number>> {
    const ranks = new Map<string, number>();

    for (const serverId of serverIds) {
      for (const period of ["week", "all"] as const) {
        const keys = await this.ensureBoard(serverId, period);

        if (!keys) {
          continue;
        }

        const rank = await this.redis.zrevrank(keys.time, steamId);

        if (rank !== null) {
          ranks.set(`${serverId}:${period}`, rank + 1);
        }
      }
    }

    return ranks;
  }

  private async namesUsed(
    steamId: string,
  ): Promise<Map<string, Array<string>>> {
    const rows = await this.postgres.query<
      Array<{ server_id: string; name: string }>
    >(
      `SELECT server_id, name
         FROM public.server_player_sessions
        WHERE player_steam_id = $1
          AND name IS NOT NULL
        GROUP BY server_id, name
        ORDER BY server_id, max(started_at) DESC`,
      [steamId],
    );

    const names = new Map<string, Array<string>>();

    for (const row of rows) {
      names.set(row.server_id, [...(names.get(row.server_id) ?? []), row.name]);
    }

    return names;
  }

  private async recentSessions(steamId: string) {
    const rows = await this.postgres.query<
      Array<{
        server_id: string;
        started_at: Date;
        ended_at: Date | null;
        ip: string | null;
      }>
    >(
      `SELECT server_id, started_at, ended_at, host(ip) AS ip
         FROM public.server_player_sessions
        WHERE player_steam_id = $1
          AND coalesce(ended_at, now()) > now() - interval '7 days'
        ORDER BY started_at DESC
        LIMIT 500`,
      [steamId],
    );

    const sessions = new Map<
      string,
      Array<{ started_at: string; ended_at: string | null; ip: string | null }>
    >();

    for (const row of rows) {
      sessions.set(row.server_id, [
        ...(sessions.get(row.server_id) ?? []),
        {
          started_at: new Date(row.started_at).toISOString(),
          ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
          ip: row.ip,
        },
      ]);
    }

    return sessions;
  }

  private async ipsUsed(steamId: string) {
    return await this.postgres.query<Array<{ ip: string; sessions: number }>>(
      `SELECT host(ip) AS ip, count(*)::int AS sessions
         FROM public.server_player_sessions
        WHERE player_steam_id = $1
          AND ip IS NOT NULL
        GROUP BY ip
        ORDER BY sessions DESC`,
      [steamId],
    );
  }

  private async ipMatches(steamId: string) {
    const rows = await this.postgres.query<
      Array<{
        steam_id: string;
        ip: string;
        sessions: number;
        last_seen_at: Date;
        online: boolean;
        session_name: string | null;
        account_name: string | null;
        avatar_url: string | null;
        has_account: boolean;
        is_banned: boolean;
      }>
    >(
      `WITH mine AS (
          SELECT DISTINCT ip
            FROM public.server_player_sessions
           WHERE player_steam_id = $1
             AND ip IS NOT NULL
       ),
       matches AS (
          SELECT o.player_steam_id,
                 o.ip,
                 count(*)::int AS sessions,
                 max(coalesce(o.ended_at, now())) AS last_seen_at,
                 bool_or(o.ended_at IS NULL) AS online,
                 (array_agg(o.name ORDER BY o.started_at DESC) FILTER (WHERE o.name IS NOT NULL))[1] AS session_name
            FROM public.server_player_sessions o
            JOIN mine ON mine.ip = o.ip
           WHERE o.player_steam_id <> $1
           GROUP BY o.player_steam_id, o.ip
       )
       SELECT m.player_steam_id::text AS steam_id,
              host(m.ip) AS ip,
              m.sessions,
              m.last_seen_at,
              m.online,
              m.session_name,
              p.name AS account_name,
              p.avatar_url,
              coalesce(p.last_sign_in_at IS NOT NULL, false) AS has_account,
              EXISTS (
                  SELECT 1 FROM public.player_sanctions ps
                   WHERE ps.player_steam_id = m.player_steam_id
                     AND ps.type = 'ban'
                     AND ps.deleted_at IS NULL
                     AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
              ) AS is_banned
         FROM matches m
         LEFT JOIN public.players p ON p.steam_id = m.player_steam_id
        ORDER BY m.online DESC, m.last_seen_at DESC
        LIMIT 50`,
      [steamId],
    );

    return rows.map((row) => ({
      steam_id: row.steam_id,
      name: row.account_name ?? row.session_name,
      avatar_url: row.avatar_url,
      has_account: row.has_account,
      is_banned: row.is_banned,
      sessions: row.sessions,
      last_seen_at: new Date(row.last_seen_at).toISOString(),
      online: row.online,
      ip: row.ip,
    }));
  }

  private static boardKeys(
    serverId: string,
    period: CommunityPeriod,
    version: string,
  ): BoardKeys {
    const base = `community:lb:${serverId}:${version}:${period}`;
    return {
      time: `${base}:time`,
      kills: `${base}:kills`,
      rows: `${base}:rows`,
      lock: `${base}:lock`,
      failed: `${base}:failed`,
    };
  }

  private static session(user?: User): string {
    return JSON.stringify({
      "x-hasura-role": user?.role ?? "guest",
      "x-hasura-user-id": user?.steam_id ?? "0",
    });
  }

  private static isPeriod(value: string): value is CommunityPeriod {
    return value === "week" || value === "all";
  }

  private static isMetric(value: string): value is CommunityMetric {
    return value === "time" || value === "kills";
  }
}
