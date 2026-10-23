import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PostgresService } from "../postgres/postgres.service";
import { FaceitQueues } from "./enums/FaceitQueues";

export type FaceitBan = {
  reason?: string;
  starts_at?: string;
  ends_at?: string | null;
};

export type FaceitCheatingBan = {
  startsAt: Date;
  endsAt: Date | null;
};

type FaceitAccount = {
  id: string;
  url: string | null;
};

@Injectable()
export class FaceitBansService {
  private static readonly BASE_URL = "https://open.faceit.com/data/v4";
  private static readonly GAMES = ["cs2", "csgo"];
  private static readonly MAX_AGE_HOURS = 1;
  private static readonly SWEEP_BATCH = 1500;
  private static readonly SWEEP_PRIORITY = 10;
  private readonly apiKey: string;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly config: ConfigService,
    @InjectQueue(FaceitQueues.CheckFaceitBans)
    private readonly queue: Queue,
  ) {
    this.apiKey = this.config.get<string>("faceit.apiKey") ?? "";
  }

  public static async enqueueChecks(
    queue: Queue,
    steamIds: Array<string>,
    priority?: number,
  ): Promise<void> {
    if (steamIds.length === 0) {
      return;
    }

    await queue.addBulk(
      steamIds.map((steamId) => ({
        name: "CheckFaceitBans",
        data: { steamId },
        opts: {
          jobId: FaceitBansService.jobId(steamId),
          priority,
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    );

    if (priority) {
      return;
    }

    // A sweep job already waiting under the same id would otherwise keep its
    // place behind the rest of the sweep.
    for (const steamId of steamIds) {
      const job = await queue.getJob(FaceitBansService.jobId(steamId));
      if (job?.priority) {
        await job.changePriority({ priority: 0 }).catch((): void => undefined);
      }
    }
  }

  private static jobId(steamId: string): string {
    return `check-faceit-bans.${steamId}`;
  }

  public static activeCheatingBan(
    bans: Array<FaceitBan>,
    now = Date.now(),
  ): FaceitCheatingBan | null {
    const active = bans.flatMap((ban) => {
      const startsAt = new Date(ban.starts_at ?? "");
      const parsedEnd = ban.ends_at ? new Date(ban.ends_at) : null;
      const endsAt =
        parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : null;

      if (
        !/cheat/i.test(ban.reason ?? "") ||
        Number.isNaN(startsAt.getTime()) ||
        (endsAt && !(endsAt.getTime() > now))
      ) {
        return [];
      }

      return [{ startsAt, endsAt }];
    });

    if (active.length === 0) {
      return null;
    }

    return {
      startsAt: new Date(
        Math.max(...active.map((ban) => ban.startsAt.getTime())),
      ),
      endsAt: active.some((ban) => !ban.endsAt)
        ? null
        : new Date(Math.max(...active.map((ban) => ban.endsAt.getTime()))),
    };
  }

  // Signing in is rare (sessions roll), so players who played since their last
  // check are queued within the hour, and every recently active player daily.
  public async queueStaleChecks(): Promise<void> {
    if (!this.apiKey) {
      return;
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `WITH recent AS (
         SELECT mlp.steam_id, max(m.created_at) AS last_played_at
           FROM public.matches m
           JOIN public.match_lineup_players mlp
             ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
          WHERE m.created_at >= now() - interval '6 months'
            AND mlp.steam_id IS NOT NULL
          GROUP BY mlp.steam_id
       ),
       due AS (
         SELECT p.steam_id,
                p.faceit_bans_checked_at,
                r.last_played_at,
                r.last_played_at > COALESCE(p.faceit_bans_checked_at, '-infinity') AS played_since
           FROM recent r
           JOIN public.players p ON p.steam_id = r.steam_id
       )
       SELECT steam_id::text AS steam_id
         FROM due
        WHERE played_since
           OR faceit_bans_checked_at < now() - interval '1 day'
        ORDER BY played_since DESC,
                 CASE WHEN played_since THEN last_played_at END DESC,
                 faceit_bans_checked_at ASC
        LIMIT $1`,
      [FaceitBansService.SWEEP_BATCH],
    );

    if (rows.length === 0) {
      return;
    }

    this.logger.log(`faceit-bans: queued ${rows.length} player(s) to re-check`);

    await FaceitBansService.enqueueChecks(
      this.queue,
      rows.map((row) => row.steam_id),
      FaceitBansService.SWEEP_PRIORITY,
    );
  }

  public async checkPlayer(steamId: string): Promise<void> {
    if (!this.apiKey) {
      return;
    }

    const [player] = await this.postgres.query<
      Array<{ faceit_player_id: string | null }>
    >(
      `SELECT faceit_player_id
         FROM public.players
        WHERE steam_id = $1::bigint
          AND (faceit_bans_checked_at IS NULL
               OR faceit_bans_checked_at < now() - make_interval(hours => $2))`,
      [steamId, FaceitBansService.MAX_AGE_HOURS],
    );

    if (!player) {
      return;
    }

    const account = player.faceit_player_id
      ? { id: player.faceit_player_id, url: null }
      : await this.findAccount(steamId);

    const bans = account ? await this.fetchBans(account.id) : null;

    // Nothing is known that wasn't before, so nothing changes; the check is
    // still stamped so a player FACEIT keeps failing on can't hold the head of
    // every sweep.
    if (!account || !bans) {
      await this.postgres.query(
        `UPDATE public.players
            SET faceit_bans_checked_at = now()
          WHERE steam_id = $1::bigint`,
        [steamId],
      );
      return;
    }

    const ban = FaceitBansService.activeCheatingBan(bans);

    await this.postgres.query(
      `UPDATE public.players
          SET faceit_banned_at = $2::timestamptz,
              faceit_ban_ends_at = $3::timestamptz,
              faceit_url = COALESCE(faceit_url, $4),
              faceit_bans_checked_at = now()
        WHERE steam_id = $1::bigint`,
      [steamId, ban?.startsAt ?? null, ban?.endsAt ?? null, account.url],
    );

    if (!ban) {
      await this.expireLiftedAutoBan(steamId);
      return;
    }

    await this.applyAutoBan(steamId);
  }

  // The row mirrors FACEIT's ban on every check. A moderator overrides it by
  // removing it, which holds until FACEIT issues a newer ban.
  private async applyAutoBan(steamId: string): Promise<void> {
    const [result] = await this.postgres.query<
      Array<{ updated: number; inserted: number }>
    >(
      `WITH target AS (
         SELECT p.steam_id,
                NULLIF(
                  public.player_source_sanction_expiry('faceit_ban', p.steam_id),
                  'infinity'::timestamptz
                ) AS remove_sanction_date
           FROM public.players p
          WHERE p.steam_id = $1::bigint
            AND p.role <> 'administrator'
            AND public.sanction_policy_scope('faceit_ban') = 'both'
            AND public.player_source_sanction_expiry('faceit_ban', p.steam_id) > now()
            AND NOT EXISTS (
              SELECT 1
                FROM public.player_sanctions ps
               WHERE ps.player_steam_id = p.steam_id
                 AND ps.type = 'ban'
                 AND ps.sanctioned_by_steam_id IS NULL
                 AND ps.reason LIKE 'Auto: FACEIT%'
                 AND ps.deleted_at >= p.faceit_banned_at
            )
       ),
       updated AS (
         UPDATE public.player_sanctions ps
            SET remove_sanction_date = t.remove_sanction_date,
                reason = $2
           FROM target t
          WHERE ps.player_steam_id = t.steam_id
            AND ps.type = 'ban'
            AND ps.sanctioned_by_steam_id IS NULL
            AND ps.reason LIKE 'Auto: FACEIT%'
            AND ps.deleted_at IS NULL
            AND ps.remove_sanction_date IS DISTINCT FROM t.remove_sanction_date
         RETURNING ps.player_steam_id
       ),
       inserted AS (
         INSERT INTO public.player_sanctions
             (player_steam_id, type, sanctioned_by_steam_id, reason, remove_sanction_date)
         SELECT t.steam_id, 'ban', NULL, $2, t.remove_sanction_date
           FROM target t
          WHERE NOT EXISTS (
            SELECT 1
              FROM public.player_sanctions ps
             WHERE ps.player_steam_id = t.steam_id
               AND ps.type = 'ban'
               AND ps.sanctioned_by_steam_id IS NULL
               AND ps.reason LIKE 'Auto: FACEIT%'
               AND ps.deleted_at IS NULL
          )
         RETURNING player_steam_id
       )
       SELECT (SELECT count(*) FROM updated)::int AS updated,
              (SELECT count(*) FROM inserted)::int AS inserted`,
      [steamId, "Auto: FACEIT cheating ban"],
    );

    if (result?.inserted || result?.updated) {
      this.logger.log(
        `faceit-bans: ${result.inserted ? "auto-banned" : "updated the auto-ban on"} ${steamId} for a cheating ban`,
      );
    }
  }

  private async expireLiftedAutoBan(steamId: string): Promise<void> {
    const expired = await this.postgres.query<Array<{ steam_id: string }>>(
      `UPDATE public.player_sanctions ps
          SET remove_sanction_date = now()
        WHERE ps.player_steam_id = $1::bigint
          AND ps.type = 'ban'
          AND ps.sanctioned_by_steam_id IS NULL
          AND ps.reason LIKE 'Auto: FACEIT%'
          AND ps.deleted_at IS NULL
          AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
        RETURNING ps.player_steam_id::text AS steam_id`,
      [steamId],
    );

    if (expired.length > 0) {
      this.logger.log(
        `faceit-bans: lifted the auto-ban on ${steamId}, FACEIT no longer reports a cheating ban`,
      );
    }
  }

  // An account banned before CS2 came to FACEIT only has a csgo profile.
  private async findAccount(steamId: string): Promise<FaceitAccount | null> {
    for (const game of FaceitBansService.GAMES) {
      const response = await this.get(
        `/players?game=${game}&game_player_id=${encodeURIComponent(steamId)}`,
      );

      if (!response) {
        return null;
      }

      if (response.status === 404) {
        continue;
      }

      const data = (await response.json()) as {
        player_id?: string;
        faceit_url?: string;
      };

      if (!data.player_id) {
        return null;
      }

      return {
        id: data.player_id,
        url: data.faceit_url ? data.faceit_url.replace("{lang}", "en") : null,
      };
    }

    return null;
  }

  private async fetchBans(playerId: string): Promise<Array<FaceitBan> | null> {
    const response = await this.get(
      `/players/${encodeURIComponent(playerId)}/bans?offset=0&limit=100`,
    );

    if (!response || response.status === 404) {
      return null;
    }

    const data = (await response.json()) as { items?: Array<FaceitBan> };

    return Array.isArray(data.items) ? data.items : null;
  }

  private async get(path: string): Promise<Response | null> {
    try {
      const response = await fetch(`${FaceitBansService.BASE_URL}${path}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok && response.status !== 404) {
        this.logger.warn(`faceit-bans: ${response.status} for ${path}`);
        return null;
      }

      return response;
    } catch (error) {
      this.logger.warn(
        `faceit-bans: request failed for ${path}: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }
}
