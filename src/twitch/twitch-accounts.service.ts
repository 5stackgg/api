import { randomBytes } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { AppConfig } from "../configs/types/AppConfig";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { AvatarsService } from "../avatars/avatars.service";
import { StreamAccessService } from "../matches/game-streamer/stream-access.service";
import { TwitchService } from "./twitch.service";
import { TwitchCredentials } from "./types/TwitchCredentials";
import { HelixStream } from "./types/HelixStream";
import { HelixUser } from "./types/HelixUser";
import { TwitchLinkError } from "./types/TwitchLinkError";
import {
  TwitchMatchStream,
  TwitchMe,
  TwitchPlayerStream,
} from "./types/TwitchStreams";

// Every read takes the viewer and leaves out anyone sharing a Live match with
// them (public.live_match_peers): a player must never watch the match they are
// in from someone else's stream. A guest could be one of those players signed
// out, so while streams require a login a guest sees nobody in a Live match
// (public.live_match_participants).
@Injectable()
export class TwitchAccountsService {
  // A live flag the poller has not confirmed for this long is not believed, so
  // a poller that stops cannot leave anyone showing as live.
  private static readonly LIVE = `(a.is_live AND a.checked_at > now() - interval '10 minutes')`;

  private static readonly STATE_TTL_SECONDS = 600;

  private static readonly STATE = /^[A-Za-z0-9_-]{32,128}$/;

  private static readonly MAX_BIGINT = 9223372036854775807n;

  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private static readonly POLL_LOCK = "twitch:poll-lock";

  private static readonly POLL_LOCK_SECONDS = 300;

  private static readonly NAMES_REFRESHED = "twitch:names-refreshed";

  private static readonly NAMES_REFRESH_SECONDS = 3600;

  private static readonly RELEASE_LOCK_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;

  private static readonly THUMBNAIL_WIDTH = 640;

  private static readonly THUMBNAIL_HEIGHT = 360;

  private redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
    private readonly twitch: TwitchService,
    private readonly streamAccess: StreamAccessService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public redirectUri(): string {
    return `${this.config.get<AppConfig>("app").webDomain}/auth/twitch/callback`;
  }

  public async startLink(steamId: string, redirect?: unknown): Promise<string> {
    const target = this.safeRedirect(redirect);

    try {
      const credentials = await this.twitch.credentials();
      if (!credentials) {
        return this.linkResult(target, "not_configured");
      }

      const state = randomBytes(32).toString("base64url");

      await this.redis.set(
        TwitchAccountsService.stateKey(state),
        JSON.stringify({ steam_id: steamId, redirect: target }),
        "EX",
        TwitchAccountsService.STATE_TTL_SECONDS,
      );

      return this.twitch.authorizeUrl(credentials, this.redirectUri(), state);
    } catch (error) {
      this.logger.error("[twitch] unable to start linking an account", error);
      return this.linkResult(target, "twitch_unavailable");
    }
  }

  public async completeLink(
    steamId: string | undefined,
    query: { code?: unknown; state?: unknown; error?: unknown },
  ): Promise<string> {
    let redirect = "/";

    try {
      const pending = await this.consumeState(query.state);

      // Bound to the player who started it, so a callback URL carrying someone
      // else's code cannot link their Twitch to whoever opens it.
      if (!pending || !steamId || pending.steam_id !== steamId) {
        return this.linkResult("/", "invalid_state");
      }

      redirect = pending.redirect;

      if (query.error || typeof query.code !== "string" || !query.code) {
        return this.linkResult(redirect, "denied");
      }

      const credentials = await this.twitch.credentials();
      if (!credentials) {
        return this.linkResult(redirect, "not_configured");
      }

      const token = await this.twitch.exchangeCode(
        credentials,
        query.code,
        this.redirectUri(),
      );

      let user: HelixUser;
      try {
        user = await this.twitch.authenticatedUser(credentials, token);
      } finally {
        void this.twitch.revokeToken(credentials, token);
      }

      if (!(await this.link(steamId, user))) {
        return this.linkResult(redirect, "already_linked");
      }

      return this.linkResult(redirect);
    } catch (error) {
      this.logger.error("[twitch] unable to link an account", error);
      return this.linkResult(redirect, "twitch_unavailable");
    }
  }

  public async link(steamId: string, user: HelixUser): Promise<boolean> {
    try {
      await this.postgres.transaction(async (client) => {
        await client.query(
          `DELETE FROM public.player_twitch_accounts
            WHERE steam_id = $1 AND twitch_user_id <> $2`,
          [steamId, user.id],
        );

        await client.query(
          `INSERT INTO public.player_twitch_accounts (steam_id, twitch_user_id, login, display_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (steam_id) DO UPDATE
              SET login = EXCLUDED.login,
                  display_name = EXCLUDED.display_name`,
          [steamId, user.id, user.login, user.display_name || null],
        );
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") {
        return false;
      }
      throw error;
    }

    return true;
  }

  public async unlink(steamId: string): Promise<void> {
    await this.postgres.query(
      `DELETE FROM public.player_twitch_accounts WHERE steam_id = $1`,
      [steamId],
    );
  }

  public async pollLiveStatus(): Promise<void> {
    const credentials = await this.twitch.credentials();
    if (!credentials) {
      return;
    }

    const token = randomBytes(16).toString("hex");
    const locked = await this.redis.set(
      TwitchAccountsService.POLL_LOCK,
      token,
      "EX",
      TwitchAccountsService.POLL_LOCK_SECONDS,
      "NX",
    );

    if (locked !== "OK") {
      return;
    }

    try {
      const accounts = await this.postgres.query<
        Array<{ twitch_user_id: string }>
      >(
        `SELECT twitch_user_id FROM public.player_twitch_accounts ORDER BY twitch_user_id`,
      );

      const ids = accounts.map(({ twitch_user_id }) => twitch_user_id);

      if (await this.refreshLiveStatus(credentials, ids)) {
        await this.refreshNamesWhenDue(credentials, ids);
      }
    } finally {
      await this.redis.eval(
        TwitchAccountsService.RELEASE_LOCK_SCRIPT,
        1,
        TwitchAccountsService.POLL_LOCK,
        token,
      );
    }
  }

  private async refreshLiveStatus(
    credentials: TwitchCredentials,
    twitchUserIds: Array<string>,
  ): Promise<boolean> {
    for (const batch of TwitchAccountsService.batches(
      twitchUserIds,
      TwitchService.STREAMS_PER_REQUEST,
    )) {
      let streams: Array<HelixStream>;
      try {
        streams = await this.twitch.liveStreams(credentials, batch);
      } catch (error) {
        // An outage must not take every stream offline; LIVE stops believing
        // the last known state on its own.
        this.logger.warn(
          `[twitch] stream check failed, keeping the last known state: ${(error as Error)?.message}`,
        );
        return false;
      }

      await this.recordLiveStatus(batch, streams);
    }

    return true;
  }

  // A live Counter-Strike stream carries its channel's login; an offline
  // channel's login is only learned here, so a rename would otherwise leave
  // the profile linking a dead or reassigned channel.
  // Never fails the tick: the live status it follows is already saved.
  private async refreshNamesWhenDue(
    credentials: TwitchCredentials,
    twitchUserIds: Array<string>,
  ): Promise<void> {
    try {
      const due = await this.redis.set(
        TwitchAccountsService.NAMES_REFRESHED,
        "1",
        "EX",
        TwitchAccountsService.NAMES_REFRESH_SECONDS,
        "NX",
      );

      if (due !== "OK") {
        return;
      }

      for (const batch of TwitchAccountsService.batches(
        twitchUserIds,
        TwitchService.USERS_PER_REQUEST,
      )) {
        await this.recordNames(await this.twitch.users(credentials, batch));
      }
    } catch (error) {
      this.logger.warn(
        `[twitch] name refresh failed: ${(error as Error)?.message}`,
      );
      await this.redis
        .del(TwitchAccountsService.NAMES_REFRESHED)
        .catch(() => 0);
    }
  }

  private static batches(
    values: Array<string>,
    size: number,
  ): Array<Array<string>> {
    const batches: Array<Array<string>> = [];
    for (let start = 0; start < values.length; start += size) {
      batches.push(values.slice(start, start + size));
    }
    return batches;
  }

  private async recordLiveStatus(
    twitchUserIds: Array<string>,
    streams: Array<HelixStream>,
  ): Promise<void> {
    const live = new Map(
      streams
        .filter(
          (stream) =>
            stream.type === "live" && TwitchService.isCounterStrike(stream),
        )
        .map((stream) => [stream.user_id, stream]),
    );

    const rows = twitchUserIds.map((twitch_user_id) => {
      const stream = live.get(twitch_user_id);

      if (!stream) {
        return { twitch_user_id, is_live: false };
      }

      return {
        twitch_user_id,
        is_live: true,
        login: stream.user_login || null,
        display_name: stream.user_name || null,
        title: stream.title ?? null,
        game_name: stream.game_name ?? null,
        viewer_count: Number.isInteger(stream.viewer_count)
          ? stream.viewer_count
          : null,
        started_at: stream.started_at || null,
        thumbnail_url: TwitchAccountsService.thumbnail(stream.thumbnail_url),
      };
    });

    await this.postgres.query(
      `UPDATE public.player_twitch_accounts a
          SET is_live = v.is_live,
              login = COALESCE(v.login, a.login),
              display_name = COALESCE(v.display_name, a.display_name),
              stream_title = v.title,
              game_name = v.game_name,
              viewer_count = v.viewer_count,
              started_at = v.started_at,
              thumbnail_url = v.thumbnail_url,
              checked_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS v(
                twitch_user_id text,
                is_live boolean,
                login text,
                display_name text,
                title text,
                game_name text,
                viewer_count integer,
                started_at timestamptz,
                thumbnail_url text
              )
        WHERE a.twitch_user_id = v.twitch_user_id`,
      [JSON.stringify(rows)],
    );
  }

  private async recordNames(users: Array<HelixUser>): Promise<void> {
    const rows = users
      .filter((user) => user?.id && user?.login)
      .map((user) => ({
        twitch_user_id: user.id,
        login: user.login,
        display_name: user.display_name || null,
      }));

    if (rows.length === 0) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.player_twitch_accounts a
          SET login = v.login,
              display_name = v.display_name
         FROM jsonb_to_recordset($1::jsonb) AS v(
                twitch_user_id text,
                login text,
                display_name text
              )
        WHERE a.twitch_user_id = v.twitch_user_id
          AND (a.login IS DISTINCT FROM v.login
               OR a.display_name IS DISTINCT FROM v.display_name)`,
      [JSON.stringify(rows)],
    );
  }

  private static thumbnail(template?: string): string | null {
    if (!template) {
      return null;
    }

    return template
      .replace("{width}", String(TwitchAccountsService.THUMBNAIL_WIDTH))
      .replace("{height}", String(TwitchAccountsService.THUMBNAIL_HEIGHT));
  }

  public async me(steamId: string): Promise<TwitchMe> {
    const [account] = await this.postgres.query<
      Array<NonNullable<TwitchMe["account"]>>
    >(
      `SELECT a.twitch_user_id,
              a.login,
              a.display_name,
              ${TwitchAccountsService.LIVE} AS is_live,
              a.stream_title AS title,
              a.game_name,
              a.viewer_count,
              a.started_at,
              a.thumbnail_url,
              a.checked_at,
              a.created_at AS linked_at
         FROM public.player_twitch_accounts a
        WHERE a.steam_id = $1`,
      [steamId],
    );

    const enabled = !!(await this.twitch.credentials());

    if (!account) {
      return { enabled, account: null };
    }

    return {
      enabled,
      account: TwitchAccountsService.withoutStaleStream({
        ...account,
        is_live: enabled && account.is_live,
      }),
    };
  }

  public async player(
    steamId: string,
    viewerSteamId?: unknown,
  ): Promise<TwitchPlayerStream | null> {
    if (
      !TwitchAccountsService.isSteamId(steamId) ||
      !(await this.twitch.credentials())
    ) {
      return null;
    }

    const audience = await this.audience(viewerSteamId);
    if (!audience) {
      return null;
    }

    const [player] = await this.postgres.query<Array<TwitchPlayerStream>>(
      `SELECT a.steam_id::text AS steam_id,
              a.login,
              a.display_name,
              ${TwitchAccountsService.LIVE} AS is_live,
              a.stream_title AS title,
              a.game_name,
              a.viewer_count,
              a.started_at,
              a.thumbnail_url
         FROM public.player_twitch_accounts a
        WHERE a.steam_id = $1
          AND ${TwitchAccountsService.visibleTo("$2", "$3")}`,
      [steamId, audience.viewer, audience.guestsHidden],
    );

    return player ? TwitchAccountsService.withoutStaleStream(player) : null;
  }

  public async liveSteamIds(viewerSteamId?: unknown): Promise<Array<string>> {
    if (!(await this.twitch.credentials())) {
      return [];
    }

    const audience = await this.audience(viewerSteamId);
    if (!audience) {
      return [];
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT a.steam_id::text AS steam_id
         FROM public.player_twitch_accounts a
        WHERE ${TwitchAccountsService.LIVE}
          AND ${TwitchAccountsService.visibleTo("$1", "$2")}
        ORDER BY a.viewer_count DESC NULLS LAST, a.steam_id`,
      [audience.viewer, audience.guestsHidden],
    );

    return rows.map(({ steam_id }) => steam_id);
  }

  public async matchStreams(
    matchId: string,
    viewerSteamId?: unknown,
  ): Promise<Array<TwitchMatchStream>> {
    if (
      !TwitchAccountsService.UUID.test(matchId ?? "") ||
      !(await this.twitch.credentials())
    ) {
      return [];
    }

    const audience = await this.audience(viewerSteamId);
    if (!audience || (audience.viewer === null && audience.guestsHidden)) {
      return [];
    }

    const streams = await this.postgres.query<Array<TwitchMatchStream>>(
      `SELECT a.steam_id::text AS steam_id,
              p.name,
              COALESCE(NULLIF(btrim(p.custom_avatar_url), ''), p.avatar_url) AS avatar_url,
              mlp.match_lineup_id,
              a.login,
              a.display_name,
              a.stream_title AS title,
              a.viewer_count,
              a.started_at,
              a.thumbnail_url
         FROM public.matches m
         JOIN public.match_lineup_players mlp
           ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
         JOIN public.players p ON p.steam_id = mlp.steam_id
         JOIN public.player_twitch_accounts a ON a.steam_id = mlp.steam_id
        WHERE m.id = $1
          AND m.status = 'Live'
          AND m.source <> 'practice'
          AND public.is_server_online(m) IS TRUE
          AND ${TwitchAccountsService.LIVE}
          AND ${TwitchAccountsService.visibleTo("$2", "$3")}
        ORDER BY mlp.match_lineup_id = m.lineup_2_id, p.name, a.steam_id`,
      [matchId, audience.viewer, audience.guestsHidden],
    );

    const { apiDomain } = this.config.get<AppConfig>("app");

    return streams.map((stream) => ({
      ...stream,
      avatar_url: AvatarsService.publicUrl(stream.avatar_url, apiDomain),
    }));
  }

  // null fails closed: a viewer that is present but not a steam id is never
  // treated as a guest.
  private async audience(
    viewerSteamId: unknown,
  ): Promise<{ viewer: string | null; guestsHidden: boolean } | null> {
    if (viewerSteamId === undefined || viewerSteamId === null) {
      return {
        viewer: null,
        guestsHidden: await this.streamAccess.requireLoginForLiveStreams(),
      };
    }

    if (!TwitchAccountsService.isSteamId(viewerSteamId)) {
      return null;
    }

    return { viewer: viewerSteamId, guestsHidden: false };
  }

  private static visibleTo(viewer: string, guestsHidden: string): string {
    return `CASE
              WHEN ${viewer}::bigint IS NOT NULL
                THEN a.steam_id NOT IN (SELECT public.live_match_peers(${viewer}::bigint))
              WHEN ${guestsHidden}::boolean
                THEN a.steam_id NOT IN (SELECT public.live_match_participants())
              ELSE true
            END`;
  }

  private static isSteamId(value: unknown): value is string {
    return (
      typeof value === "string" &&
      /^\d{1,19}$/.test(value) &&
      BigInt(value) <= TwitchAccountsService.MAX_BIGINT
    );
  }

  private static withoutStaleStream<
    T extends {
      is_live: boolean;
      title: string | null;
      game_name: string | null;
      viewer_count: number | null;
      started_at: Date | null;
      thumbnail_url: string | null;
    },
  >(row: T): T {
    if (row.is_live) {
      return row;
    }

    return {
      ...row,
      title: null,
      game_name: null,
      viewer_count: null,
      started_at: null,
      thumbnail_url: null,
    };
  }

  private safeRedirect(redirect: unknown): string {
    const { webDomain, authCookieDomain } = this.config.get<AppConfig>("app");

    if (
      typeof redirect === "string" &&
      SteamGuard.isSafeRedirect(redirect, webDomain, authCookieDomain)
    ) {
      return redirect;
    }

    return "/";
  }

  private linkResult(redirect: unknown, error?: TwitchLinkError): string {
    const url = new URL(
      this.safeRedirect(redirect),
      this.config.get<AppConfig>("app").webDomain,
    );

    if (error) {
      url.searchParams.set("twitch_error", error);
    } else {
      url.searchParams.set("twitch", "linked");
    }

    return url.toString();
  }

  private async consumeState(
    state: unknown,
  ): Promise<{ steam_id: string; redirect: string } | null> {
    if (typeof state !== "string" || !TwitchAccountsService.STATE.test(state)) {
      return null;
    }

    const key = TwitchAccountsService.stateKey(state);
    const results = await this.redis.multi().get(key).del(key).exec();
    const value = results?.[0]?.[1];

    if (typeof value !== "string") {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private static stateKey(state: string): string {
    return `twitch:oauth-state:${state}`;
  }
}
