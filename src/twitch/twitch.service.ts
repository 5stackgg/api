import { createHash } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { TwitchCredentials } from "./types/TwitchCredentials";
import { HelixStream } from "./types/HelixStream";
import { HelixUser } from "./types/HelixUser";

// Twitch over HTTP. The keys are the operator's, read from settings on every
// call so a change in Application Settings needs no restart, and no Twitch
// token belonging to a player outlives the request that obtained it.
@Injectable()
export class TwitchService {
  public static readonly COUNTER_STRIKE_GAME_ID = "32399";

  public static readonly COUNTER_STRIKE_GAME_NAME = "Counter-Strike";

  public static readonly STREAMS_PER_REQUEST = 100;

  private static readonly OAUTH = "https://id.twitch.tv/oauth2";

  private static readonly HELIX = "https://api.twitch.tv/helix";

  private static readonly TIMEOUT_MS = 10_000;

  private static readonly TOKEN_EXPIRY_MARGIN_SECONDS = 300;

  private redis: Redis;

  private appTokenRequests = new Map<string, Promise<string>>();

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async credentials(): Promise<TwitchCredentials | null> {
    const rows = await this.postgres.query<
      Array<{ name: string; value: string | null }>
    >(`SELECT name, value FROM public.settings WHERE name = ANY($1::text[])`, [
      [SystemSettingName.TwitchClientId, SystemSettingName.TwitchClientSecret],
    ]);

    const value = (name: SystemSettingName) =>
      rows.find((row) => row.name === name)?.value?.trim() ?? "";

    const clientId = value(SystemSettingName.TwitchClientId);
    const clientSecret = value(SystemSettingName.TwitchClientSecret);

    if (!clientId || !clientSecret) {
      return null;
    }

    return { clientId, clientSecret };
  }

  public static isCounterStrike(
    stream: Pick<HelixStream, "game_id" | "game_name">,
  ): boolean {
    return (
      stream.game_id === TwitchService.COUNTER_STRIKE_GAME_ID ||
      stream.game_name === TwitchService.COUNTER_STRIKE_GAME_NAME
    );
  }

  public authorizeUrl(
    credentials: TwitchCredentials,
    redirectUri: string,
    state: string,
  ): string {
    const url = new URL(`${TwitchService.OAUTH}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "");
    url.searchParams.set("state", state);
    return url.toString();
  }

  public async exchangeCode(
    credentials: TwitchCredentials,
    code: string,
    redirectUri: string,
  ): Promise<string> {
    const { access_token } = await this.oauth<{ access_token?: string }>(
      "token",
      {
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      },
    );

    if (!access_token) {
      throw new Error("twitch returned no user token");
    }

    return access_token;
  }

  public async authenticatedUser(
    credentials: TwitchCredentials,
    userToken: string,
  ): Promise<HelixUser> {
    const response = await fetch(`${TwitchService.HELIX}/users`, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Client-Id": credentials.clientId,
      },
      signal: AbortSignal.timeout(TwitchService.TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`twitch users answered ${response.status}`);
    }

    const { data } = (await response.json()) as { data?: Array<HelixUser> };
    const [user] = data ?? [];

    if (!user?.id || !user?.login) {
      throw new Error("twitch returned no user");
    }

    return user;
  }

  public async revokeToken(
    credentials: TwitchCredentials,
    token: string,
  ): Promise<void> {
    try {
      await this.oauth("revoke", {
        client_id: credentials.clientId,
        token,
      });
    } catch (error) {
      this.logger.warn(
        `[twitch] unable to revoke a user token: ${(error as Error)?.message}`,
      );
    }
  }

  public async liveStreams(
    credentials: TwitchCredentials,
    userIds: Array<string>,
  ): Promise<Array<HelixStream>> {
    if (userIds.length === 0) {
      return [];
    }

    if (userIds.length > TwitchService.STREAMS_PER_REQUEST) {
      throw new Error(
        `at most ${TwitchService.STREAMS_PER_REQUEST} users per streams request`,
      );
    }

    const url = new URL(`${TwitchService.HELIX}/streams`);
    url.searchParams.set("type", "live");
    // Helix pages at 20 unless told otherwise, which would silently drop
    // every live channel past the twentieth.
    url.searchParams.set("first", String(TwitchService.STREAMS_PER_REQUEST));
    for (const id of userIds) {
      url.searchParams.append("user_id", id);
    }

    const { data } = await this.helix<{ data?: Array<HelixStream> }>(
      credentials,
      url,
    );

    return data ?? [];
  }

  public async appToken(credentials: TwitchCredentials): Promise<string> {
    const key = TwitchService.appTokenKey(credentials);

    const cached = await this.redis.get(key);
    if (cached) {
      return cached;
    }

    let request = this.appTokenRequests.get(key);
    if (!request) {
      request = this.requestAppToken(credentials, key).finally(() => {
        this.appTokenRequests.delete(key);
      });
      this.appTokenRequests.set(key, request);
    }

    return await request;
  }

  private async requestAppToken(
    credentials: TwitchCredentials,
    key: string,
  ): Promise<string> {
    const { access_token, expires_in } = await this.oauth<{
      access_token?: string;
      expires_in?: number;
    }>("token", {
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "client_credentials",
    });

    if (!access_token) {
      throw new Error("twitch returned no app token");
    }

    const ttl = Math.max(
      60,
      Math.floor((expires_in ?? 0) - TwitchService.TOKEN_EXPIRY_MARGIN_SECONDS),
    );

    await this.redis.set(key, access_token, "EX", ttl);

    return access_token;
  }

  // Keyed by the keys themselves, so replacing either one in settings stops
  // the old app's token being used without anything having to clear it.
  private static appTokenKey(credentials: TwitchCredentials): string {
    const digest = createHash("sha256")
      .update(`${credentials.clientId}:${credentials.clientSecret}`)
      .digest("hex")
      .slice(0, 16);

    return `twitch:app-token:${digest}`;
  }

  private async helix<T>(
    credentials: TwitchCredentials,
    url: URL,
    retry = true,
  ): Promise<T> {
    const token = await this.appToken(credentials);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": credentials.clientId,
      },
      signal: AbortSignal.timeout(TwitchService.TIMEOUT_MS),
    });

    if (response.status === 401 && retry) {
      await this.redis.del(TwitchService.appTokenKey(credentials));
      return await this.helix<T>(credentials, url, false);
    }

    if (!response.ok) {
      throw new Error(`twitch helix answered ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private async oauth<T>(
    path: "token" | "revoke",
    form: Record<string, string>,
  ): Promise<T> {
    const response = await fetch(`${TwitchService.OAUTH}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TwitchService.TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`twitch oauth ${path} answered ${response.status}`);
    }

    if (path === "revoke") {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
