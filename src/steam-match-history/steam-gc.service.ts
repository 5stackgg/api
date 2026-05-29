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

const CS2_APP_ID = 730;
const REFRESH_TOKEN_CACHE_KEY = "steam-gc:refresh-token";
const REQUEST_TIMEOUT_MS = 30_000;

export type ResolvedMatch = {
  demoUrl: string;
  mapName: string | null;
  matchStartTime: string | null;
};

@Injectable()
export class SteamGcService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private client?: SteamUser;
  private cs?: GlobalOffensive;
  private gcReady = false;
  private starting = false;

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

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isAvailable()) {
      this.logger.warn(
        "steam-gc disabled: STEAM_USER / STEAM_PASSWORD not configured",
      );
      return;
    }
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.client?.logOff();
  }

  private async connect(): Promise<void> {
    if (this.starting) {
      return;
    }
    this.starting = true;

    const client = new SteamUser({
      enablePicsCache: false,
      autoRelogin: true,
    });
    const cs = new GlobalOffensive(client);

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
    });

    cs.on("connectedToGC", () => {
      this.gcReady = true;
      this.logger.log("steam-gc gc connected");
    });

    cs.on("disconnectedFromGC", (reason: number) => {
      this.gcReady = false;
      this.logger.log(`steam-gc gc disconnected (${reason})`);
    });

    this.client = client;
    this.cs = cs;

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

    this.starting = false;
  }

  public async resolveShareCode(
    shareCode: string,
  ): Promise<ResolvedMatch | null> {
    if (!this.cs || !this.gcReady) {
      this.logger.warn(`steam-gc not ready, cannot resolve ${shareCode}`);
      return null;
    }

    const cs = this.cs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cs.removeListener("matchList", onMatchList);
        this.logger.warn(`steam-gc timeout resolving ${shareCode}`);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);

      const onMatchList = (matches: unknown): void => {
        clearTimeout(timer);
        cs.removeListener("matchList", onMatchList);
        resolve(SteamGcService.extractMatchInfo(matches));
      };

      cs.on("matchList", onMatchList);
      try {
        cs.requestGame(shareCode);
      } catch (err) {
        clearTimeout(timer);
        cs.removeListener("matchList", onMatchList);
        this.logger.error(
          `steam-gc requestGame threw for ${shareCode}: ${(err as Error).message}`,
        );
        resolve(null);
      }
    });
  }

  private static extractMatchInfo(matches: unknown): ResolvedMatch | null {
    if (!Array.isArray(matches) || matches.length === 0) {
      return null;
    }
    const match = matches.at(0) as {
      matchtime?: number;
      watchablematchinfo?: { game_mapgroup?: string; game_map?: string };
      roundstats_legacy?: { map?: string };
      roundstatsall?: Array<{ map?: string }>;
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

    return { demoUrl, mapName, matchStartTime };
  }
}
