import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PostgresService } from "../postgres/postgres.service";

export type FaceitBan = {
  reason?: string;
  starts_at?: string;
  ends_at?: string | null;
};

export type FaceitCheatingBan = {
  startsAt: Date;
  endsAt: Date | null;
};

@Injectable()
export class FaceitBansService {
  private static readonly BASE_URL = "https://open.faceit.com/data/v4";
  private static readonly GAMES = ["cs2", "csgo"];
  private static readonly MAX_AGE_HOURS = 1;
  private readonly apiKey: string;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly config: ConfigService,
  ) {
    this.apiKey = this.config.get<string>("faceit.apiKey") ?? "";
  }

  public static activeCheatingBan(
    bans: Array<FaceitBan>,
    now = Date.now(),
  ): FaceitCheatingBan | null {
    const active = bans.flatMap((ban) => {
      const startsAt = new Date(ban.starts_at ?? "");
      const endsAt = ban.ends_at ? new Date(ban.ends_at) : null;

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

    const playerId =
      player.faceit_player_id ?? (await this.findPlayerId(steamId));

    if (playerId === undefined) {
      return;
    }

    let ban: FaceitCheatingBan | null = null;

    if (playerId) {
      const bans = await this.fetchBans(playerId);
      if (!bans) {
        return;
      }
      ban = FaceitBansService.activeCheatingBan(bans);
    }

    await this.postgres.query(
      `UPDATE public.players
          SET faceit_banned_at = $2::timestamptz,
              faceit_ban_ends_at = $3::timestamptz,
              faceit_bans_checked_at = now()
        WHERE steam_id = $1::bigint`,
      [steamId, ban?.startsAt ?? null, ban?.endsAt ?? null],
    );

    if (!ban) {
      await this.expireLiftedAutoBan(steamId);
      return;
    }

    await this.applyAutoBan(steamId);
  }

  private async applyAutoBan(steamId: string): Promise<void> {
    const banned = await this.postgres.query<Array<{ steam_id: string }>>(
      `WITH target AS (
         SELECT p.steam_id,
                -- NULL is a ban with no end, so LEAST keeps whichever of the
                -- policy and FACEIT ends first.
                LEAST(
                  NULLIF(
                    public.player_source_sanction_expiry('faceit_ban', p.steam_id),
                    'infinity'::timestamptz
                  ),
                  p.faceit_ban_ends_at
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
                 AND ps.deleted_at IS NULL
                 AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
            )
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
       reactivated AS (
         UPDATE public.player_sanctions ps
            SET remove_sanction_date = t.remove_sanction_date,
                reason = $2
           FROM target t
          WHERE ps.player_steam_id = t.steam_id
            AND ps.type = 'ban'
            AND ps.sanctioned_by_steam_id IS NULL
            AND ps.reason LIKE 'Auto: FACEIT%'
            AND ps.deleted_at IS NULL
         RETURNING ps.player_steam_id
       ),
       inserted AS (
         INSERT INTO public.player_sanctions
             (player_steam_id, type, sanctioned_by_steam_id, reason, remove_sanction_date)
         SELECT t.steam_id, 'ban', NULL, $2, t.remove_sanction_date
           FROM target t
          WHERE NOT EXISTS (SELECT 1 FROM reactivated)
         RETURNING player_steam_id
       )
       SELECT player_steam_id::text AS steam_id FROM reactivated
       UNION ALL
       SELECT player_steam_id::text AS steam_id FROM inserted`,
      [steamId, "Auto: FACEIT cheating ban"],
    );

    if (banned.length > 0) {
      this.logger.log(`faceit-bans: auto-banned ${steamId} for a cheating ban`);
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

  // undefined: FACEIT could not be asked. null: no FACEIT account. An account
  // banned before CS2 came to FACEIT only has a csgo profile.
  private async findPlayerId(
    steamId: string,
  ): Promise<string | null | undefined> {
    for (const game of FaceitBansService.GAMES) {
      const response = await this.get(
        `/players?game=${game}&game_player_id=${encodeURIComponent(steamId)}`,
      );

      if (!response) {
        return undefined;
      }

      if (response.status === 404) {
        continue;
      }

      const data = (await response.json()) as { player_id?: string };

      return data.player_id ?? null;
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

    return data.items ?? [];
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
