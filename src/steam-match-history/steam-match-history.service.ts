import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { SteamMatchHistoryQueues } from "./enums/SteamMatchHistoryQueues";
import { ResolveMatchMetadata } from "./jobs/ResolveMatchMetadata";
import { decodeShareCode } from "./shareCode";

export type PollResult = {
  collected: number;
  lastShareCode: string | null;
  error: string | null;
};

@Injectable()
export class SteamMatchHistoryService {
  private static readonly STEAM_API_BASE =
    "https://api.steampowered.com/ICSGOPlayers_730";
  private static readonly MAX_CODES_PER_POLL = 50;
  private static readonly POLL_COOLDOWN_SECONDS = 10 * 60;
  private static readonly RATE_LIMITED_COOLDOWN_SECONDS = 60 * 60;
  private static readonly INTER_REQUEST_DELAY_MS = 300;
  private readonly steamApiKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly logger: Logger,
    @InjectQueue(SteamMatchHistoryQueues.ResolveMatchMetadata)
    private readonly resolveQueue: Queue,
  ) {
    this.steamApiKey = this.config.get("steam.steamApiKey");
  }

  public isEnabled(): boolean {
    return !!this.steamApiKey;
  }

  // Operator-facing switch (public.external_matches_enabled). Off unless an
  // admin has explicitly enabled it ("true"); mirrors the web default so the
  // UI and the import enforcement agree.
  public async isImportingAllowed(): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = 'public.external_matches_enabled' LIMIT 1`,
    );
    return rows.at(0)?.value === "true";
  }

  public async getCloudflareWorkerUrl(): Promise<string | null> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = 'cloudflare_worker_url' LIMIT 1`,
    );
    const value = rows.at(0)?.value?.trim();
    return value ? value.replace(/\/+$/, "") : null;
  }

  public async linkAccount(
    steamId: string,
    authCode: string,
    knownShareCode: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.isEnabled()) {
      return { ok: false, error: "STEAM_WEB_API_KEY not configured" };
    }

    if (!(await this.isImportingAllowed())) {
      return { ok: false, error: "external match imports are disabled" };
    }

    const probe = await this.fetchNextShareCode(
      steamId,
      authCode,
      knownShareCode,
    );

    if (probe.error) {
      return { ok: false, error: probe.error };
    }

    await this.hasura.mutation({
      insert_player_steam_match_auth_one: {
        __args: {
          object: {
            steam_id: steamId,
            auth_code: authCode,
            last_known_share_code: knownShareCode,
            last_polled_at: null,
            last_error: null,
          },
          on_conflict: {
            constraint: "player_steam_match_auth_pkey",
            update_columns: ["auth_code", "last_known_share_code"],
          },
        },
        __typename: true,
      },
    });

    this.logger.log(`steam-match-history linked steam_id=${steamId}`);

    void (async () => {
      try {
        await this.pollForUser(steamId);
      } catch (error) {
        this.logger.warn(
          `steam-match-history initial poll failed for ${steamId}: ${(error as Error)?.message}`,
        );
      }
    })();

    return { ok: true };
  }

  public async unlinkAccount(steamId: string): Promise<void> {
    await this.hasura.mutation({
      delete_player_steam_match_auth_by_pk: {
        __args: { steam_id: steamId },
        __typename: true,
      },
    });
    this.logger.log(`steam-match-history unlinked steam_id=${steamId}`);
  }

  public async retryPendingImport(
    steamId: string,
    valveMatchId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.isImportingAllowed())) {
      return { ok: false, error: "external match imports are disabled" };
    }
    const isRequester = await this.isPendingRequester(steamId, valveMatchId);
    if (!isRequester) {
      return { ok: false, error: "not a requester for this import" };
    }
    const updated = await this.postgres.query<
      Array<{ valve_match_id: string }>
    >(
      `UPDATE public.pending_match_imports
         SET status = 'Queued', error = NULL
       WHERE valve_match_id = $1::numeric AND status = 'Failed'
       RETURNING valve_match_id`,
      [valveMatchId],
    );
    if (updated.length === 0) {
      return { ok: false, error: "import is not in Failed state" };
    }
    await this.enqueueResolve(valveMatchId);
    return { ok: true };
  }

  public async clearPendingImport(
    steamId: string,
    valveMatchId: string,
  ): Promise<{ ok: boolean }> {
    await this.postgres.query(
      `DELETE FROM public.pending_match_import_players
       WHERE valve_match_id = $1::numeric AND steam_id = $2::bigint`,
      [valveMatchId, steamId],
    );
    await this.postgres.query(
      `DELETE FROM public.pending_match_imports
       WHERE valve_match_id = $1::numeric
         AND NOT EXISTS (
           SELECT 1 FROM public.pending_match_import_players
           WHERE valve_match_id = $1::numeric
         )`,
      [valveMatchId],
    );
    return { ok: true };
  }

  private async isPendingRequester(
    steamId: string,
    valveMatchId: string,
  ): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ valve_match_id: string }>>(
      `SELECT valve_match_id FROM public.pending_match_import_players
       WHERE valve_match_id = $1::numeric AND steam_id = $2::bigint
       LIMIT 1`,
      [valveMatchId, steamId],
    );
    return rows.length > 0;
  }

  public async pollForUser(steamId: string): Promise<PollResult> {
    if (!this.isEnabled()) {
      return {
        collected: 0,
        lastShareCode: null,
        error: "STEAM_WEB_API_KEY not configured",
      };
    }

    if (!(await this.isImportingAllowed())) {
      return {
        collected: 0,
        lastShareCode: null,
        error: "external match imports are disabled",
      };
    }

    const cooldownKey = SteamMatchHistoryService.cooldownKey(steamId);
    if (await this.cache.has(cooldownKey)) {
      return {
        collected: 0,
        lastShareCode: null,
        error: "within poll cooldown",
      };
    }
    await this.cache.put(
      cooldownKey,
      true,
      SteamMatchHistoryService.POLL_COOLDOWN_SECONDS,
    );

    const link = await this.loadLink(steamId);
    if (!link) {
      return {
        collected: 0,
        lastShareCode: null,
        error: "no linked auth for steam_id",
      };
    }

    let known = link.last_known_share_code;
    const collected: string[] = [];
    let pollError: string | null = null;

    for (let i = 0; i < SteamMatchHistoryService.MAX_CODES_PER_POLL; i++) {
      const result = await this.fetchNextShareCode(
        steamId,
        link.auth_code,
        known,
      );

      if (result.rateLimited) {
        await this.cache.put(
          cooldownKey,
          true,
          SteamMatchHistoryService.RATE_LIMITED_COOLDOWN_SECONDS,
        );
        pollError = result.error;
        break;
      }
      if (result.error) {
        pollError = result.error;
        break;
      }
      if (!result.nextCode) {
        break;
      }

      collected.push(result.nextCode);
      known = result.nextCode;

      if (i + 1 < SteamMatchHistoryService.MAX_CODES_PER_POLL) {
        await new Promise((res) =>
          setTimeout(res, SteamMatchHistoryService.INTER_REQUEST_DELAY_MS),
        );
      }
    }

    await this.hasura.mutation({
      update_player_steam_match_auth_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: {
            last_known_share_code: known,
            last_polled_at: new Date(),
            last_error: pollError,
          },
        },
        __typename: true,
      },
    });

    this.logger.log(
      `steam-match-history poll steam_id=${steamId} ` +
        `collected=${collected.length} ` +
        `error=${pollError ?? "none"}`,
    );

    for (const shareCode of collected) {
      await this.recordPendingImport(steamId, shareCode);
    }

    return {
      collected: collected.length,
      lastShareCode: known,
      error: pollError,
    };
  }

  public async pollAllActive(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.warn(
        "steam-match-history pollAllActive skipped: STEAM_WEB_API_KEY not configured",
      );
      return;
    }

    if (!(await this.isImportingAllowed())) {
      this.logger.log(
        "steam-match-history pollAllActive skipped: external match imports disabled",
      );
      return;
    }

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const { player_steam_match_auth } = await this.hasura.query({
      player_steam_match_auth: {
        __args: {
          where: {
            player: {
              last_sign_in_at: { _gte: cutoff.toISOString() },
            },
          },
        },
        steam_id: true,
      },
    });

    this.logger.log(
      `steam-match-history pollAllActive selected ${player_steam_match_auth.length} active users (signed in since ${cutoff.toISOString()})`,
    );

    const concurrency = 2;
    const queue = player_steam_match_auth.map((row) => String(row.steam_id));
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const steamId = queue.shift();
        if (!steamId) {
          return;
        }
        try {
          await this.pollForUser(steamId);
        } catch (error) {
          this.logger.error(
            `steam-match-history pollForUser failed for ${steamId}`,
            error,
          );
        }
      }
    });
    await Promise.all(workers);
  }

  private async loadLink(
    steamId: string,
  ): Promise<{ auth_code: string; last_known_share_code: string } | null> {
    const { player_steam_match_auth_by_pk } = await this.hasura.query({
      player_steam_match_auth_by_pk: {
        __args: { steam_id: steamId },
        auth_code: true,
        last_known_share_code: true,
      },
    });
    return player_steam_match_auth_by_pk ?? null;
  }

  private async fetchNextShareCode(
    steamId: string,
    authCode: string,
    knownCode: string,
  ): Promise<{
    nextCode: string | null;
    error: string | null;
    rateLimited?: boolean;
  }> {
    const params = new URLSearchParams({
      key: this.steamApiKey,
      steamid: steamId,
      steamidkey: authCode,
      knowncode: knownCode,
    });
    const url = `${SteamMatchHistoryService.STEAM_API_BASE}/GetNextMatchSharingCode/v1?${params.toString()}`;

    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
      });

      if (response.status === 403) {
        return { nextCode: null, error: "invalid auth_code or share_code" };
      }
      if (response.status === 202) {
        return { nextCode: null, error: null };
      }
      if (response.status === 429) {
        return {
          nextCode: null,
          error: "steam web api 429 rate limited",
          rateLimited: true,
        };
      }
      if (!response.ok) {
        return {
          nextCode: null,
          error: `steam web api responded with ${response.status}`,
        };
      }

      const body = (await response.json()) as {
        result?: { nextcode?: string };
      };
      const next = body.result?.nextcode;
      if (!next || next === "n/a") {
        return { nextCode: null, error: null };
      }
      return { nextCode: next, error: null };
    } catch (error) {
      this.logger.error(
        `steam-match-history fetch failed for ${steamId}`,
        error,
      );
      return { nextCode: null, error: "fetch failed" };
    }
  }

  private async recordPendingImport(
    steamId: string,
    shareCode: string,
  ): Promise<void> {
    let valveMatchId: bigint;
    try {
      valveMatchId = decodeShareCode(shareCode).matchId;
    } catch (err) {
      this.logger.warn(
        `skipping bad share_code ${shareCode}: ${(err as Error).message}`,
      );
      return;
    }

    const rows = await this.postgres.query<Array<{ inserted: boolean }>>(
      `INSERT INTO public.pending_match_imports (valve_match_id, share_code)
       VALUES ($1::numeric, $2)
       ON CONFLICT (valve_match_id) DO UPDATE SET valve_match_id = EXCLUDED.valve_match_id
       RETURNING (xmax = 0) AS inserted`,
      [valveMatchId.toString(), shareCode],
    );
    const newlyCreated = rows.at(0)?.inserted === true;

    await this.postgres.query(
      `INSERT INTO public.pending_match_import_players (valve_match_id, steam_id)
       VALUES ($1::numeric, $2::bigint)
       ON CONFLICT DO NOTHING`,
      [valveMatchId.toString(), steamId],
    );

    if (newlyCreated) {
      await this.enqueueResolve(valveMatchId.toString());
    }
  }

  // Removes any prior terminal job with this id so re-adding actually
  // queues. We keep removeOnComplete off so completed jobs stay in
  // Redis as a processed-count history; the explicit remove is the
  // cleanest way to re-enqueue without losing that signal.
  private async enqueueResolve(valveMatchId: string): Promise<void> {
    const jobId = `resolve-${valveMatchId}`;
    await this.resolveQueue.remove(jobId).catch(() => {});
    await this.resolveQueue.add(
      ResolveMatchMetadata.name,
      { valve_match_id: valveMatchId },
      {
        jobId,
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );
  }

  private static cooldownKey(steamId: string): string {
    return `steam-match-history:poll-cooldown:v2:${steamId}`;
  }
}
