import { Injectable, Logger } from "@nestjs/common";
import { isIP } from "net";
import Redis from "ioredis";
import { PostgresService } from "src/postgres/postgres.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";

export type RosterEntry = {
  steam_id: string;
  conn: string | null;
  name: string | null;
  ip: string | null;
  kills: number;
  deaths: number;
};

export type DepartedEntry = {
  steam_id: string;
  conn: string;
  kills: number;
  deaths: number;
};

@Injectable()
export class ServerRosterService {
  // Read by DedicatedServersService.getAllDedicatedServerStats, so the public
  // server list shows the plugin's live count instead of the minute-old RCON one.
  public static readonly COUNTS_KEY = "dedicated-servers:roster-counts";

  private static readonly COUNT_TTL_SECONDS = 180;
  private static readonly MAX_PLAYERS = 64;
  private static readonly MAX_DEPARTED = 256;
  private static readonly MAX_CONN_LENGTH = 64;
  private static readonly MAX_COUNTER = 100_000;
  private static readonly MAX_NAME_LENGTH = 64;
  private static readonly STEAM_ID = /^7656119\d{10}$/;

  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    redisManager: RedisManagerService,
  ) {
    this.redis = redisManager.getConnection();
  }

  // Rides on the sanctions sync, so it never throws: a roster problem must not
  // stop sanctions from being enforced. Answers whether the roster was
  // recorded, which tells the plugin it may forget the departures it sent.
  public async apply(
    serverId: string,
    players: unknown,
    departed: unknown,
  ): Promise<boolean> {
    const roster = ServerRosterService.rosterEntries(players);

    if (!roster) {
      if (players === null) {
        await this.touch(serverId);
      }
      return false;
    }

    try {
      const [row] = await this.postgres.query<Array<{ online: number }>>(
        `SELECT public.sync_server_player_sessions($1, $2::jsonb, $3::jsonb) AS online`,
        [
          serverId,
          JSON.stringify(roster),
          JSON.stringify(ServerRosterService.departedEntries(departed)),
        ],
      );

      await this.recordCount(serverId, row?.online ?? roster.length);

      return true;
    } catch (error) {
      this.logger.warn(
        `[${serverId}] unable to record the player roster: ${(error as Error)?.message ?? error}`,
      );
      return false;
    }
  }

  // An explicit null is a current plugin holding its roster through a map
  // change or a reload. The players are still connected, so a roster that is
  // still fresh stays fresh; otherwise a slow map load would trip the sweeper
  // and the gap rule and split everyone's session in two. Only for a while,
  // though: a roster already past the gap window, or held longer than any map
  // load takes, is left to go stale so its sessions end. Older plugins send no
  // field at all.
  private async touch(serverId: string): Promise<void> {
    try {
      await this.postgres.query(
        `UPDATE public.server_rosters
            SET reported_at = clock_timestamp(),
                held_since = coalesce(held_since, clock_timestamp())
          WHERE server_id = $1
            AND reported_at > clock_timestamp() - interval '2 minutes'
            AND (held_since IS NULL
                 OR held_since > clock_timestamp() - interval '5 minutes')`,
        [serverId],
      );
    } catch (error) {
      this.logger.warn(
        `[${serverId}] unable to refresh the held player roster: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  public async liveCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const entries = await this.redis.hgetall(ServerRosterService.COUNTS_KEY);

    for (const [serverId, value] of Object.entries(entries ?? {})) {
      const players = Number(value);
      if (Number.isInteger(players)) {
        counts[serverId] = players;
      }
    }

    return counts;
  }

  public async clearCounts(serverIds: Array<string>): Promise<void> {
    if (serverIds.length === 0) {
      return;
    }

    await this.redis.hdel(ServerRosterService.COUNTS_KEY, ...serverIds);
  }

  // A null or missing roster means the plugin does not know it yet (just
  // loaded, map changing) or predates rosters; either way, leave the sessions
  // alone rather than closing everyone.
  public static rosterEntries(value: unknown): Array<RosterEntry> | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const entries = new Map<string, RosterEntry>();

    for (const item of value) {
      if (entries.size >= ServerRosterService.MAX_PLAYERS) {
        break;
      }

      const steamId = ServerRosterService.steamId(item?.steam_id);

      if (!steamId || entries.has(steamId)) {
        continue;
      }

      entries.set(steamId, {
        steam_id: steamId,
        conn: ServerRosterService.conn(item?.conn),
        name: ServerRosterService.playerName(item?.name),
        ip: ServerRosterService.ip(item?.ip),
        kills: ServerRosterService.counter(item?.kills),
        deaths: ServerRosterService.counter(item?.deaths),
      });
    }

    return [...entries.values()];
  }

  // One entry per finished connection. A player can be in both lists: they
  // left and rejoined between two syncs.
  public static departedEntries(value: unknown): Array<DepartedEntry> {
    if (!Array.isArray(value)) {
      return [];
    }

    const entries = new Map<string, DepartedEntry>();

    for (const item of value) {
      if (entries.size >= ServerRosterService.MAX_DEPARTED) {
        break;
      }

      const steamId = ServerRosterService.steamId(item?.steam_id);
      const conn = ServerRosterService.conn(item?.conn);

      if (!steamId || !conn || entries.has(`${steamId}:${conn}`)) {
        continue;
      }

      entries.set(`${steamId}:${conn}`, {
        steam_id: steamId,
        conn,
        kills: ServerRosterService.counter(item?.kills),
        deaths: ServerRosterService.counter(item?.deaths),
      });
    }

    return [...entries.values()];
  }

  // Player-chosen text shown to moderators: control and bidi/format characters
  // could reorder or hide what is rendered next to it, and a lone surrogate
  // would make the whole roster invalid JSON to Postgres.
  public static playerName(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const cleaned = value
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned.length === 0) {
      return null;
    }

    return Array.from(cleaned)
      .slice(0, ServerRosterService.MAX_NAME_LENGTH)
      .join("");
  }

  // The engine reports "ip:port", or "[v6]:port"; anything that does not parse
  // is dropped here because an invalid inet would fail the whole sync. Node
  // accepts a v6 zone id ("fe80::1%eth0") that inet does not.
  public static ip(value: unknown): string | null {
    if (typeof value !== "string" || value.includes("%")) {
      return null;
    }

    let address = value.trim();

    const bracketed = address.match(/^\[([^\]]+)\](?::\d+)?$/);

    if (bracketed) {
      address = bracketed[1];
    } else if (address.split(":").length === 2) {
      address = address.split(":")[0];
    }

    return isIP(address) === 0 ? null : address;
  }

  // Strings only: a 17-digit SteamID64 sent as a JSON number has already lost
  // precision by the time it is parsed.
  private static steamId(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    return ServerRosterService.STEAM_ID.test(value) ? value : null;
  }

  private static conn(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const conn = value.trim();

    if (
      conn.length === 0 ||
      conn.length > ServerRosterService.MAX_CONN_LENGTH ||
      !/^[\w.:-]+$/.test(conn)
    ) {
      return null;
    }

    return conn;
  }

  private static counter(value: unknown): number {
    const count = Number(value);

    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > ServerRosterService.MAX_COUNTER
    ) {
      return 0;
    }

    return count;
  }

  private async recordCount(serverId: string, online: number): Promise<void> {
    await this.redis.hset(
      ServerRosterService.COUNTS_KEY,
      serverId,
      String(online),
    );

    await this.redis.sendCommand(
      new Redis.Command("HEXPIRE", [
        ServerRosterService.COUNTS_KEY,
        ServerRosterService.COUNT_TTL_SECONDS,
        "FIELDS",
        1,
        serverId,
      ]),
    );
  }
}
