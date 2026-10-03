import { Injectable, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { ChatGif } from "./types/ChatGif";

export interface ChatGifResult {
  id: string;
  title: string;
  width: number;
  height: number;
}

export interface ChatGifPage {
  results: ChatGifResult[];
  next: number | null;
}

type GiphyImage = { width?: string; height?: string };

type GiphyGif = {
  id?: string;
  title?: string;
  images?: { original?: GiphyImage; fixed_width?: GiphyImage };
};

// Searches go through here so the operator's key never reaches a browser. Only
// GIPHY's answer is cached, for a few minutes -- the GIFs themselves are always
// loaded from GIPHY, as its terms ask.
@Injectable()
export class ChatGifsService {
  public static readonly PAGE_SIZE = 24;

  public static readonly MAX_QUERY_LENGTH = 50;

  // The key is a quota shared by everyone on the panel.
  public static readonly RATE_LIMIT = 30;

  private static readonly RATE_WINDOW_MS = 60_000;

  private static readonly CACHE_TTL_SECONDS = 600;

  private static readonly TRENDING_CACHE_TTL_SECONDS = 60 * 60;

  // GIPHY's beta keys allow 100 calls an hour, between everyone on the panel.
  public static readonly DEFAULT_HOURLY_LIMIT = 90;

  // GIPHY refuses an offset past this.
  private static readonly MAX_OFFSET = 4999;

  private static readonly MAX_DIMENSION = 4096;

  private static readonly ENDPOINT = "https://api.giphy.com/v1/gifs";

  private static readonly ID = /^[A-Za-z0-9]{1,64}$/;

  private static readonly RATE_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;

  private redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public static gif(raw: unknown): ChatGif | null {
    if (typeof raw !== "object" || raw === null) {
      return null;
    }

    const { id, width, height } = raw as Record<string, unknown>;

    if (typeof id !== "string" || !ChatGifsService.ID.test(id)) {
      return null;
    }

    const size = (value: unknown) =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= ChatGifsService.MAX_DIMENSION;

    if (!size(width) || !size(height)) {
      return null;
    }

    return { id, width: width as number, height: height as number };
  }

  public async enabled(): Promise<boolean> {
    return !!(await this.apiKey());
  }

  public async search(
    steamId: string,
    query: string,
    offset: number,
  ): Promise<
    ChatGifPage | "disabled" | "rate_limited" | "busy" | "unavailable"
  > {
    const key = await this.apiKey();

    if (!key) {
      return "disabled";
    }

    const term = (query ?? "")
      .trim()
      .slice(0, ChatGifsService.MAX_QUERY_LENGTH);
    const start =
      Number.isInteger(offset) &&
      offset >= 0 &&
      offset <= ChatGifsService.MAX_OFFSET
        ? offset
        : 0;

    const cacheKey = `chat:gifs:${term.toLowerCase()}:${start}`;
    const cached = await this.redis.get(cacheKey);

    if (cached !== null) {
      return JSON.parse(cached) as ChatGifPage;
    }

    const count = await this.redis.eval(
      ChatGifsService.RATE_SCRIPT,
      1,
      `chat:gifs-rate:${steamId}`,
      ChatGifsService.RATE_WINDOW_MS,
    );

    if (Number(count) > ChatGifsService.RATE_LIMIT) {
      return "rate_limited";
    }

    if (!(await this.withinHourlyLimit())) {
      return "busy";
    }

    // No `rating`: the operator asked for GIPHY unfiltered, and leaving it out
    // is how GIPHY's API says "every rating".
    const url = new URL(
      `${ChatGifsService.ENDPOINT}/${term ? "search" : "trending"}`,
    );
    url.searchParams.set("api_key", key);
    url.searchParams.set("limit", String(ChatGifsService.PAGE_SIZE));
    url.searchParams.set("offset", String(start));
    if (term) {
      url.searchParams.set("q", term);
    }

    let body: {
      data?: GiphyGif[];
      pagination?: { total_count?: number; count?: number; offset?: number };
    };

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.warn(`[giphy] search answered ${response.status}`);
        return "unavailable";
      }

      body = await response.json();
    } catch (error) {
      this.logger.warn(`[giphy] search failed: ${(error as Error)?.message}`);
      return "unavailable";
    }

    const page: ChatGifPage = {
      results: (body.data ?? [])
        .map((gif) => ChatGifsService.toResult(gif))
        .filter((result): result is ChatGifResult => result !== null),
      next: ChatGifsService.nextOffset(start, body.pagination),
    };

    await this.redis.set(
      cacheKey,
      JSON.stringify(page),
      "EX",
      term
        ? ChatGifsService.CACHE_TTL_SECONDS
        : ChatGifsService.TRENDING_CACHE_TTL_SECONDS,
    );

    return page;
  }

  private static toResult(gif: GiphyGif): ChatGifResult | null {
    const image = gif.images?.original ?? gif.images?.fixed_width;
    const width = Number(image?.width);
    const height = Number(image?.height);

    if (
      typeof gif.id !== "string" ||
      !ChatGifsService.ID.test(gif.id) ||
      !(width > 0) ||
      !(height > 0)
    ) {
      return null;
    }

    return {
      id: gif.id,
      title: typeof gif.title === "string" ? gif.title : "",
      width: Math.min(Math.round(width), ChatGifsService.MAX_DIMENSION),
      height: Math.min(Math.round(height), ChatGifsService.MAX_DIMENSION),
    };
  }

  private static nextOffset(
    start: number,
    pagination?: { total_count?: number; count?: number },
  ): number | null {
    const count = pagination?.count ?? 0;
    const next = start + count;

    if (
      count === 0 ||
      next > ChatGifsService.MAX_OFFSET ||
      (typeof pagination?.total_count === "number" &&
        next >= pagination.total_count)
    ) {
      return null;
    }

    return next;
  }

  private async withinHourlyLimit(): Promise<boolean> {
    const hour = new Date().toISOString().slice(0, 13);

    const count = await this.redis.eval(
      ChatGifsService.RATE_SCRIPT,
      1,
      `chat:gifs-hourly:${hour}`,
      2 * 60 * 60 * 1000,
    );

    return Number(count) <= (await this.hourlyCalls());
  }

  private async hourlyCalls(): Promise<number> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1`,
      [SystemSettingName.GiphyHourlyLimit],
    );

    const parsed = Number.parseInt(row?.value ?? "", 10);
    return Number.isInteger(parsed) && parsed >= 0
      ? parsed
      : ChatGifsService.DEFAULT_HOURLY_LIMIT;
  }

  // Read straight from postgres, like PruneDirectMessages: SystemModule
  // imports ChatModule, so going through SystemService closes a module cycle.
  // Never cached: an api pod holding the old key would answer the settings
  // page with the state from before it saved, and the lookup is one row by
  // primary key next to a call out to GIPHY.
  private async apiKey(): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1`,
      [SystemSettingName.GiphyApiKey],
    );

    return row?.value?.trim() || null;
  }
}
