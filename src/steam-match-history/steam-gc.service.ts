import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import SteamUser from "steam-user";
import GlobalOffensive from "globaloffensive";
import { CacheService } from "../cache/cache.service";
import { MatchParty } from "./types/MatchParty";

const CS2_APP_ID = 730;
const REFRESH_TOKEN_CACHE_KEY = "steam-gc:refresh-token";
const REQUEST_TIMEOUT_MS = 30_000;
const GC_READY_TIMEOUT_MS = 30_000;
const IDLE_LOGOFF_MS = 5 * 60_000;

export type ResolvedMatch = {
  demoUrl: string;
  mapName: string | null;
  matchStartTime: string | null;
  parties: MatchParty[] | null;
};

// account id -> steam64
const STEAM_ID_BASE = 76561197960265728n;

export class SteamGcConnectionError extends Error {}

@Injectable()
export class SteamGcService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private client?: SteamUser;
  private cs?: GlobalOffensive;
  private gcReady = false;
  private connecting?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {}

  public isAvailable(): boolean {
    return (
      !!this.config.get<string>("steam.steamUser") &&
      !!this.config.get<string>("steam.steamPassword")
    );
  }

  public isReady(): boolean {
    return this.gcReady;
  }

  onApplicationBootstrap(): void {
    if (!this.isAvailable()) {
      this.logger.warn(
        "steam-gc disabled: STEAM_USER / STEAM_PASSWORD not configured",
      );
    }
  }

  onApplicationShutdown(): void {
    this.teardown();
  }

  private async ensureReady(): Promise<void> {
    if (this.gcReady && this.cs) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new SteamUser({
      enablePicsCache: false,
      autoRelogin: true,
    });
    const cs = new GlobalOffensive(client);

    let settled = false;
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    client.on("refreshToken", async (token: string) => {
      this.logger.log("steam-gc received refresh token, persisting to redis");
      await this.cache.put(REFRESH_TOKEN_CACHE_KEY, token);
    });

    client.on("loggedOn", () => {
      this.logger.log(
        `steam-gc logged on as ${client.steamID?.getSteamID64()}`,
      );
      client.setPersona(SteamUser.EPersonaState.Online);
      client.gamesPlayed([CS2_APP_ID]);
    });

    client.on("error", (err: Error) => {
      this.logger.error(`steam-gc client error: ${err.message}`);
      if (err.message.toLowerCase().includes("invalidpassword")) {
        void this.cache.put(REFRESH_TOKEN_CACHE_KEY, "");
      }
      if (!settled) {
        settled = true;
        rejectReady(new SteamGcConnectionError(err.message));
      }
      // Any client-level error (LogonSessionReplaced, dropped session, etc.)
      // leaves a dead GC. Discard the client so the next request logs in fresh.
      if (this.client === client) {
        this.teardown();
      }
    });

    cs.on("connectedToGC", () => {
      if (this.cs !== cs) {
        return;
      }
      this.gcReady = true;
      this.logger.log("steam-gc gc connected");
      if (!settled) {
        settled = true;
        resolveReady();
      }
    });

    cs.on("disconnectedFromGC", (reason: number) => {
      if (this.cs !== cs) {
        return;
      }
      this.gcReady = false;
      this.logger.log(`steam-gc gc disconnected (${reason})`);
    });

    this.client = client;
    this.cs = cs;

    await this.logOn(client);

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      rejectReady(
        new SteamGcConnectionError("timed out waiting for gc connection"),
      );
      if (this.client === client) {
        this.teardown();
      }
    }, GC_READY_TIMEOUT_MS);

    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  private async logOn(client: SteamUser): Promise<void> {
    const refreshToken = await this.cache.get(REFRESH_TOKEN_CACHE_KEY);
    if (refreshToken && typeof refreshToken === "string") {
      this.logger.log("steam-gc logging in with stored refresh token");
      client.logOn({ refreshToken });
    } else {
      this.logger.log("steam-gc logging in with STEAM_USER credentials");
      client.logOn({
        accountName: this.config.get<string>("steam.steamUser"),
        password: this.config.get<string>("steam.steamPassword"),
      });
    }
  }

  private teardown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.gcReady = false;
    const client = this.client;
    const cs = this.cs;
    this.client = undefined;
    this.cs = undefined;
    cs?.removeAllListeners();
    if (client) {
      client.removeAllListeners();
      try {
        client.logOff();
      } catch {
        // already disconnected
      }
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.logger.log("steam-gc idle, logging off");
      this.teardown();
    }, IDLE_LOGOFF_MS);
    this.idleTimer.unref?.();
  }

  public async resolveShareCode(
    shareCode: string,
  ): Promise<ResolvedMatch | null> {
    const matches = await this.requestMatchList(
      (cs) => cs.requestGame(shareCode),
      shareCode,
    );
    return SteamGcService.extractMatchInfo(matches);
  }

  private async requestMatchList(
    send: (cs: GlobalOffensive) => void,
    label: string,
  ): Promise<unknown> {
    await this.ensureReady();

    const cs = this.cs;
    if (!cs) {
      throw new SteamGcConnectionError("steam-gc not connected");
    }

    try {
      return await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          cs.removeListener("matchList", onMatchList);
          this.logger.warn(`steam-gc timeout resolving ${label}`);
          resolve(null);
        }, REQUEST_TIMEOUT_MS);

        const onMatchList = (matches: unknown): void => {
          clearTimeout(timer);
          cs.removeListener("matchList", onMatchList);
          resolve(matches);
        };

        cs.on("matchList", onMatchList);
        try {
          send(cs);
        } catch (err) {
          clearTimeout(timer);
          cs.removeListener("matchList", onMatchList);
          this.logger.error(
            `steam-gc request threw for ${label}: ${(err as Error).message}`,
          );
          resolve(null);
        }
      });
    } finally {
      this.armIdleTimer();
    }
  }

  private static extractMatchInfo(matches: unknown): ResolvedMatch | null {
    if (!Array.isArray(matches) || matches.length === 0) {
      return null;
    }
    const match = matches.at(0) as {
      matchtime?: number;
      watchablematchinfo?: { game_mapgroup?: string; game_map?: string };
      roundstats_legacy?: { map?: string };
      roundstatsall?: Array<{
        map?: string;
        // The reservation the GC handed the game server. account_ids and
        // party_ids are index-aligned; players who queued together share a
        // party id. This is the only place the queue grouping survives.
        reservation?: { account_ids?: number[]; party_ids?: number[] };
      }>;
    };

    let demoUrl: string | null = null;
    const legacy = match.roundstats_legacy?.map;
    if (typeof legacy === "string" && legacy.startsWith("http")) {
      demoUrl = legacy;
    }
    if (!demoUrl) {
      const all = match.roundstatsall;
      if (Array.isArray(all)) {
        for (let i = all.length - 1; i >= 0; i--) {
          const url = all[i]?.map;
          if (typeof url === "string" && url.startsWith("http")) {
            demoUrl = url;
            break;
          }
        }
      }
    }
    if (!demoUrl) {
      return null;
    }

    const matchStartTime =
      typeof match.matchtime === "number" && match.matchtime > 0
        ? new Date(match.matchtime * 1000).toISOString()
        : null;

    const rawMap =
      match.watchablematchinfo?.game_map ??
      match.watchablematchinfo?.game_mapgroup ??
      null;
    // game_mapgroup is "mg_de_dust2"-style; strip the "mg_" prefix.
    const mapName = rawMap?.replace(/^mg_/, "") ?? null;

    return {
      demoUrl,
      mapName,
      matchStartTime,
      parties: SteamGcService.extractParties(match.roundstatsall),
    };
  }

  // Zips the reservation's index-aligned account_ids/party_ids into per-player
  // party membership. Returns null when the GC gave us no reservation — party
  // data is a bonus, never a reason to fail an import.
  private static extractParties(
    roundStats?: Array<{
      reservation?: { account_ids?: number[]; party_ids?: number[] };
    }>,
  ): MatchParty[] | null {
    if (!Array.isArray(roundStats)) {
      return null;
    }

    // Later entries are the fuller picture; take the last one that has both
    // halves of the pairing.
    let reservation: { account_ids?: number[]; party_ids?: number[] } | null =
      null;
    for (let i = roundStats.length - 1; i >= 0; i--) {
      const candidate = roundStats[i]?.reservation;
      if (candidate?.account_ids?.length && candidate?.party_ids?.length) {
        reservation = candidate;
        break;
      }
    }
    if (!reservation) {
      return null;
    }

    const accountIds = reservation.account_ids ?? [];
    const partyIds = reservation.party_ids ?? [];

    const byParty = new Map<string, string[]>();
    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i];
      const partyId = partyIds[i];
      // 0 / missing means "queued alone" — not a party.
      if (!accountId || !partyId) {
        continue;
      }
      const key = String(partyId);
      const steamId = (BigInt(accountId) + STEAM_ID_BASE).toString();
      byParty.set(key, [...(byParty.get(key) ?? []), steamId]);
    }

    const parties: MatchParty[] = [];
    for (const [partyKey, steamIds] of byParty) {
      // A "party" of one is just a solo queuer whose party id happened to be
      // populated.
      if (steamIds.length < 2) {
        continue;
      }
      for (const steamId of steamIds) {
        parties.push({ steam_id: steamId, party_key: partyKey });
      }
    }

    return parties.length > 0 ? parties : null;
  }
}
