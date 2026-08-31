import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { SteamMatchHistoryQueues } from "./enums/SteamMatchHistoryQueues";

type SteamBan = {
  SteamId: string;
  CommunityBanned: boolean;
  VACBanned: boolean;
  NumberOfVACBans: number;
  DaysSinceLastBan: number;
  NumberOfGameBans: number;
  EconomyBan: string;
};

@Injectable()
export class SteamBansService {
  private readonly steamApiKey: string;
  private readonly redis: Redis;

  public static readonly PENDING_KEY = "steam-bans:pending";
  public static readonly DRAIN_JOB_ID = "steam-bans-drain";
  private static readonly STEAM_BANS_BATCH = 100;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly config: ConfigService,
    private readonly redisManager: RedisManagerService,
    @InjectQueue(SteamMatchHistoryQueues.CheckSteamBans)
    private readonly steamBansQueue: Queue,
  ) {
    this.steamApiKey = this.config.get<string>("steam.steamApiKey") ?? "";
    this.redis = this.redisManager.getConnection();
  }

  public static async enqueueChecks(
    redis: Redis,
    queue: Queue,
    steamIds: string[],
  ): Promise<void> {
    if (steamIds.length === 0) {
      return;
    }
    await redis.sadd(SteamBansService.PENDING_KEY, ...steamIds);
    await queue.add(
      "DrainSteamBans",
      {},
      {
        jobId: SteamBansService.DRAIN_JOB_ID,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    new Logger(SteamBansService.name).debug(
      `steam-bans enqueued ${steamIds.length} player(s) to pending; drain kicked`,
    );
  }

  public queuePlayerChecks(steamIds: string[]): void {
    void SteamBansService.enqueueChecks(
      this.redis,
      this.steamBansQueue,
      steamIds,
    ).catch((error) =>
      this.logger.error(
        `failed to enqueue steam-ban check for ${steamIds.length} player(s)`,
        error,
      ),
    );
  }

  public async drainPending(): Promise<void> {
    if (!this.steamApiKey) {
      return;
    }
    this.logger.debug("steam-bans drain start");
    let total = 0;
    for (;;) {
      const ids = await this.redis.spop(
        SteamBansService.PENDING_KEY,
        SteamBansService.STEAM_BANS_BATCH,
      );
      if (!ids || ids.length === 0) {
        break;
      }
      this.logger.debug(`steam-bans drain popped ${ids.length} pending id(s)`);
      await this.checkPlayers(ids, { maxAgeHours: 1 });
      total += ids.length;
    }
    this.logger.debug(`steam-bans drain done, ${total} player(s) processed`);
  }

  public async checkPlayers(
    steamIds: string[],
    opts?: { maxAgeHours?: number },
  ): Promise<void> {
    if (!this.steamApiKey || steamIds.length === 0) {
      return;
    }

    this.logger.debug(
      `steam-bans check start for ${steamIds.length} player(s)`,
    );

    const targets = opts?.maxAgeHours
      ? await this.filterStale(steamIds, opts.maxAgeHours)
      : steamIds;
    if (targets.length === 0) {
      this.logger.debug(
        `steam-bans all ${steamIds.length} player(s) fresh within ${opts?.maxAgeHours}h cache, skipping`,
      );
      return;
    }

    this.logger.debug(
      `steam-bans ${targets.length}/${steamIds.length} stale, fetching GetPlayerBans`,
    );

    const bans = await this.fetchBans(targets);
    if (bans.length === 0) {
      return;
    }

    await this.storeBans(bans);

    await this.expireLiftedAutoBans(
      bans.filter((ban) => ban.NumberOfVACBans === 0).map((ban) => ban.SteamId),
    );

    const flagged = bans.filter((ban) => ban.NumberOfVACBans > 0);

    this.logger.debug(
      `steam-bans ${flagged.length} flagged (vac) of ${bans.length} fetched`,
    );

    if (flagged.length === 0) {
      return;
    }

    if (!(await this.isEnforcementEnabled())) {
      this.logger.log(
        `steam-bans: ${flagged.length} flagged player(s) detected but enforcement is disabled`,
      );
      return;
    }

    await this.applyAutoBans(flagged);
  }

  public async scanAll(): Promise<void> {
    if (!this.steamApiKey) {
      return;
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT steam_id::text AS steam_id
         FROM public.match_lineup_players
        WHERE steam_id IS NOT NULL`,
    );

    if (rows.length === 0) {
      return;
    }

    const steamIds = rows.map((row) => row.steam_id);

    await this.postgres.query(
      `UPDATE public.players
          SET steam_bans_checked_at = NULL
        WHERE steam_id = ANY($1::bigint[])`,
      [steamIds],
    );

    this.logger.log(
      `steam-bans: manual scan of ${steamIds.length} player(s) (cache cleared)`,
    );

    this.queuePlayerChecks(steamIds);
  }

  private static readonly PERIODIC_BATCH = 500;

  public async checkAllActive(): Promise<void> {
    if (!this.steamApiKey) {
      return;
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT p.steam_id::text AS steam_id
         FROM public.players p
        WHERE (p.steam_bans_checked_at IS NULL
               OR p.steam_bans_checked_at < now() - interval '1 day')
          AND EXISTS (
            SELECT 1
              FROM public.match_lineup_players mlp
              JOIN public.matches m
                ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
             WHERE mlp.steam_id = p.steam_id
               AND m.created_at >= now() - interval '6 months'
          )
        ORDER BY p.steam_bans_checked_at ASC NULLS FIRST
        LIMIT $1`,
      [SteamBansService.PERIODIC_BATCH],
    );

    if (rows.length === 0) {
      return;
    }

    this.logger.log(
      `steam-bans: re-checking ${rows.length} recently-active player(s)`,
    );

    this.queuePlayerChecks(rows.map((row) => row.steam_id));
  }

  public async checkMatchPlayers(matchId: string): Promise<void> {
    if (!this.steamApiKey) {
      return;
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT mlp.steam_id::text AS steam_id
         FROM public.matches m
         JOIN public.match_lineup_players mlp
           ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
        WHERE m.id = $1::uuid
          AND mlp.steam_id IS NOT NULL`,
      [matchId],
    );

    if (rows.length === 0) {
      return;
    }

    this.queuePlayerChecks(rows.map((row) => row.steam_id));
  }

  private async filterStale(
    steamIds: string[],
    maxAgeHours: number,
  ): Promise<string[]> {
    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM public.players
        WHERE steam_id = ANY($1::bigint[])
          AND (steam_bans_checked_at IS NULL
               OR steam_bans_checked_at < now() - ($2 || ' hours')::interval)`,
      [steamIds, `${maxAgeHours}`],
    );
    return rows.map((row) => row.steam_id);
  }

  private async fetchBans(steamIds: string[]): Promise<SteamBan[]> {
    const bans: SteamBan[] = [];

    for (let i = 0; i < steamIds.length; i += 100) {
      const batch = steamIds.slice(i, i + 100);
      const url = new URL(
        "https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/",
      );
      url.searchParams.set("key", this.steamApiKey);
      url.searchParams.set("steamids", batch.join(","));

      this.logger.debug(
        `steam-bans GET GetPlayerBans for ${batch.length} id(s)`,
      );
      const startedAt = Date.now();

      try {
        const res = await fetch(url.toString());
        if (!res.ok) {
          this.logger.warn(
            `GetPlayerBans http ${res.status} for ${batch.length} players`,
          );
          continue;
        }
        const body = (await res.json()) as { players?: SteamBan[] };
        bans.push(...(body.players ?? []));
        this.logger.debug(
          `steam-bans fetched ${body.players?.length ?? 0} ban record(s) in ${Date.now() - startedAt}ms`,
        );
      } catch (error) {
        this.logger.warn(
          `GetPlayerBans failed: ${(error as Error)?.message ?? String(error)}`,
        );
      }
    }

    return bans;
  }

  private async storeBans(bans: SteamBan[]): Promise<void> {
    const ids: string[] = [];
    const vacBanned: string[] = [];
    const vacCounts: number[] = [];
    const gameCounts: number[] = [];
    const daysSince: number[] = [];

    for (const ban of bans) {
      if (!ban.SteamId) {
        continue;
      }
      ids.push(ban.SteamId);
      vacBanned.push(ban.VACBanned ? "true" : "false");
      vacCounts.push(ban.NumberOfVACBans ?? 0);
      gameCounts.push(ban.NumberOfGameBans ?? 0);
      daysSince.push(ban.DaysSinceLastBan ?? 0);
    }

    if (ids.length === 0) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.players AS p
          SET vac_banned = CASE
                WHEN EXISTS (
                  SELECT 1
                    FROM public.player_sanctions ps
                   WHERE ps.player_steam_id = p.steam_id
                     AND ps.type = 'ban'
                     AND ps.sanctioned_by_steam_id IS NULL
                     AND ps.deleted_at IS NOT NULL
                     AND ps.deleted_at::date >= (now() - (v.days_since_last_ban || ' days')::interval)::date
                ) THEN p.vac_banned
                ELSE v.vac_banned
              END,
              vac_ban_count = v.vac_ban_count,
              game_ban_count = v.game_ban_count,
              days_since_last_ban = v.days_since_last_ban,
              steam_bans_checked_at = now()
         FROM (
           SELECT UNNEST($1::bigint[])  AS steam_id,
                  UNNEST($2::boolean[]) AS vac_banned,
                  UNNEST($3::int[])     AS vac_ban_count,
                  UNNEST($4::int[])     AS game_ban_count,
                  UNNEST($5::int[])     AS days_since_last_ban
         ) AS v
        WHERE p.steam_id = v.steam_id`,
      [ids, vacBanned, vacCounts, gameCounts, daysSince],
    );
  }

  private async applyAutoBans(bans: SteamBan[]): Promise<void> {
    if (!(await this.writesPlatformBan())) {
      this.logger.log(
        `steam-bans: ${bans.length} flagged player(s) left to the scoped ` +
          `cooldown; the vac_ban sanction is not scoped to the whole platform`,
      );
      return;
    }

    const flaggedIds = bans.map((ban) => ban.SteamId);
    const flaggedDays = bans.map((ban) => ban.DaysSinceLastBan ?? 0);

    const needsBan = await this.postgres.query<
      Array<{ steam_id: string; remove_sanction_date: Date | null }>
    >(
      `SELECT p.steam_id::text AS steam_id,
              NULLIF(
                public.player_source_sanction_expiry('vac_ban', p.steam_id),
                'infinity'::timestamptz
              ) AS remove_sanction_date
         FROM public.players p
         JOIN UNNEST($1::bigint[], $2::int[]) AS f(steam_id, days_since_last_ban)
           ON p.steam_id = f.steam_id
        WHERE p.role <> 'administrator'
          AND NOT EXISTS (
            SELECT 1
              FROM public.player_sanctions ps
             WHERE ps.player_steam_id = p.steam_id
               AND ps.type = 'ban'
               AND ps.deleted_at IS NULL
               AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
          )
          AND NOT EXISTS (
            SELECT 1
              FROM public.player_sanctions ps
             WHERE ps.player_steam_id = p.steam_id
               AND ps.type = 'ban'
               AND ps.sanctioned_by_steam_id IS NULL
               AND ps.deleted_at IS NOT NULL
               AND ps.deleted_at::date >= (now() - (f.days_since_last_ban || ' days')::interval)::date
          )
          -- The policy decides whether this ban happens at all: NULL here means
          -- the vac_ban source is off, or its threshold or decay window says
          -- this account has not earned one. With the shipped defaults it is
          -- never NULL for a flagged account.
          AND public.player_source_sanction_expiry('vac_ban', p.steam_id) IS NOT NULL`,
      [flaggedIds, flaggedDays],
    );

    if (needsBan.length === 0) {
      return;
    }

    const byId = new Map(bans.map((ban) => [ban.SteamId, ban]));
    const ids = needsBan.map((row) => row.steam_id);
    const reasons = ids.map((id) => SteamBansService.banReason(byId.get(id)));
    // NULL is how player_sanctions spells a ban with no end date, which is what
    // the shipped ladder ('0') resolves to.
    const removeDates = needsBan.map((row) => row.remove_sanction_date);

    const reactivated = await this.postgres.query<Array<{ steam_id: string }>>(
      `UPDATE public.player_sanctions ps
          SET remove_sanction_date = v.remove_sanction_date, reason = v.reason
         FROM UNNEST($1::bigint[], $2::text[], $3::timestamptz[])
              AS v(steam_id, reason, remove_sanction_date)
        WHERE ps.player_steam_id = v.steam_id
          AND ps.type = 'ban'
          AND ps.sanctioned_by_steam_id IS NULL
          AND ps.deleted_at IS NULL
      RETURNING ps.player_steam_id::text AS steam_id`,
      [ids, reasons, removeDates],
    );

    const reactivatedIds = new Set(reactivated.map((row) => row.steam_id));
    const freshIds: string[] = [];
    const freshReasons: string[] = [];
    const freshRemoveDates: Array<Date | null> = [];
    ids.forEach((id, index) => {
      if (!reactivatedIds.has(id)) {
        freshIds.push(id);
        freshReasons.push(reasons[index]);
        freshRemoveDates.push(removeDates[index]);
      }
    });

    if (freshIds.length > 0) {
      await this.postgres.query(
        `INSERT INTO public.player_sanctions
            (player_steam_id, type, sanctioned_by_steam_id, reason, remove_sanction_date)
         SELECT v.steam_id, 'ban', NULL, v.reason, v.remove_sanction_date
           FROM UNNEST($1::bigint[], $2::text[], $3::timestamptz[])
                AS v(steam_id, reason, remove_sanction_date)`,
        [freshIds, freshReasons, freshRemoveDates],
      );
    }

    this.logger.log(
      `steam-bans: auto-banned ${ids.length} player(s) for VAC bans ` +
        `(${freshIds.length} new, ${reactivatedIds.size} reactivated)`,
    );
  }

  private async expireLiftedAutoBans(steamIds: string[]): Promise<void> {
    if (steamIds.length === 0) {
      return;
    }

    const expired = await this.postgres.query<
      Array<{ player_steam_id: string }>
    >(
      `UPDATE public.player_sanctions
          SET remove_sanction_date = now()
        WHERE player_steam_id = ANY($1::bigint[])
          AND type = 'ban'
          AND sanctioned_by_steam_id IS NULL
          AND deleted_at IS NULL
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())
        RETURNING player_steam_id::text AS player_steam_id`,
      [steamIds],
    );

    if (expired.length > 0) {
      this.logger.log(
        `steam-bans: expired ${expired.length} auto-ban(s) whose Steam ban is no longer present`,
      );
    }
  }

  private static banReason(ban?: SteamBan): string {
    if (!ban || ban.NumberOfVACBans === 0) {
      return "Auto: Steam VAC ban";
    }
    return `Auto: Steam ${ban.NumberOfVACBans} VAC ban(s), last ${ban.DaysSinceLastBan}d ago`;
  }

  // Part of the configurable sanctions policy (the `vac_ban` source). Its
  // shipped defaults reproduce what this service did when the numbers were
  // hardcoded: enabled, fires on the first VAC ban, never decays, never lifts,
  // and bars the whole platform.
  private async isEnforcementEnabled(): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ enabled: boolean }>>(
      `SELECT COALESCE(public.sanction_policy_enabled('vac_ban'), true) AS enabled`,
    );
    return rows.at(0)?.enabled !== false;
  }

  // A player_sanctions ban is enforced by is_banned() across the whole platform,
  // so it is only an honest way to carry this source when the operator has left
  // the scope at "both". Narrowed to one surface, the ban row is skipped and the
  // scoped cooldown (public.player_sanction_expiry) does the gating instead --
  // reading the same players.vac_banned flag storeBans keeps up to date.
  private async writesPlatformBan(): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ platform: boolean }>>(
      `SELECT public.sanction_policy_scope('vac_ban') = 'both' AS platform`,
    );
    return rows.at(0)?.platform !== false;
  }
}
