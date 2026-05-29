import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";

export type FaceitPlayerData = {
  faceit_player_id: string;
  faceit_nickname: string;
  faceit_url: string | null;
  faceit_skill_level: number | null;
  faceit_elo: number | null;
};

@Injectable()
export class FaceitService {
  private static readonly BASE_URL = "https://open.faceit.com/data/v4";
  private static readonly REFRESH_INTERVAL_SECONDS = 60 * 60;
  private readonly apiKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly logger: Logger,
  ) {
    this.apiKey = this.config.get("faceit.apiKey");
  }

  public isEnabled(): boolean {
    return !!this.apiKey;
  }

  public async refreshPlayer(steamId: string): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    const cacheKey = FaceitService.cacheKey(steamId);
    if (await this.cache.has(cacheKey)) {
      return false;
    }

    await this.cache.put(
      cacheKey,
      true,
      FaceitService.REFRESH_INTERVAL_SECONDS,
    );

    this.logger.log(`faceit refresh start for ${steamId}`);
    const startedAt = Date.now();
    const data = await this.fetchPlayer(steamId);
    const elapsedMs = Date.now() - startedAt;

    if (!data) {
      // No faceit profile linked to this steam id. The redis lock will
      // keep us from re-querying for an hour; we deliberately do NOT
      // touch the players row so the columns stay NULL and the UI keeps
      // the chip hidden.
      this.logger.log(
        `faceit fetched for ${steamId} in ${elapsedMs}ms: no profile, skipping db write`,
      );
      return false;
    }

    this.logger.log(
      `faceit fetched for ${steamId} in ${elapsedMs}ms: ` +
        `nickname=${data.faceit_nickname} ` +
        `level=${data.faceit_skill_level} ` +
        `elo=${data.faceit_elo}`,
    );

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: {
            faceit_player_id: data.faceit_player_id,
            faceit_nickname: data.faceit_nickname,
            faceit_skill_level: data.faceit_skill_level,
            faceit_elo: data.faceit_elo,
            faceit_url: data.faceit_url,
            faceit_updated_at: new Date(),
          },
        },
        __typename: true,
      },
    });

    this.logger.log(`faceit row written for ${steamId}`);

    return true;
  }

  private async fetchPlayer(steamId: string): Promise<FaceitPlayerData | null> {
    const url = `${FaceitService.BASE_URL}/players?game=cs2&game_player_id=${encodeURIComponent(
      steamId,
    )}`;

    this.logger.log(`faceit GET ${url}`);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });

      if (response.status === 404) {
        this.logger.log(
          `faceit 404 for steam_id ${steamId} — no faceit account linked`,
        );
        return null;
      }

      if (!response.ok) {
        this.logger.error(
          `faceit responded with ${response.status} for steam_id ${steamId}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        player_id: string;
        nickname: string;
        faceit_url?: string;
        games?: {
          cs2?: {
            skill_level?: number;
            faceit_elo?: number;
          };
        };
      };

      const cs2 = data.games?.cs2;

      return {
        faceit_player_id: data.player_id,
        faceit_nickname: data.nickname,
        faceit_url: data.faceit_url
          ? data.faceit_url.replace("{lang}", "en")
          : null,
        faceit_skill_level: cs2?.skill_level ?? null,
        faceit_elo: cs2?.faceit_elo ?? null,
      };
    } catch (error) {
      this.logger.error(
        `unable to fetch faceit profile for steam_id ${steamId}`,
        error,
      );
      return null;
    }
  }

  private static cacheKey(steamId: string): string {
    return `faceit:refresh-lock:cs2:${steamId}`;
  }
}
