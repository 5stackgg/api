import zlib from "zlib";
import { promisify } from "util";
import { Request, Response } from "express";
import { Injectable, Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import { FieldMeta, FragmentField } from "./types/fragment.types";

// Broadcast state lives in redis rather than in the process, so an api restart
// or rollout does not drop every live broadcast and more than one replica can
// serve the relay.
//
// Everything a broadcast stores is keyed by its token as well as the match. A
// new token (a new map, or the server restarting the broadcast) starts over at
// low fragment numbers, so keying by match alone would let a half-finished
// cleanup serve one map's fragment as another's.
@Injectable()
export class MatchRelayService {
  private static readonly NUMERIC_QUERY_FIELDS = [
    "tick",
    "endtick",
    "tps",
    "keyframe_interval",
    "protocol",
  ];

  // Like Valve's reference relay, /sync starts a new client this many fragments
  // behind the newest one, and the client then plays in real time.
  private static readonly SYNC_LAG_FRAGMENTS = 7;

  private static readonly FRAGMENT_TTL_SECONDS = 60;

  // Every post pushes this back, so it only runs out once the game server has
  // been silent this long.
  private static readonly BROADCAST_TTL_SECONDS = 60 * 60;

  // Fragment data expires after FRAGMENT_TTL_SECONDS; this only bounds the
  // index that /sync walks.
  private static readonly INDEX_WINDOW = 64;

  private static readonly IMMUTABLE = "public, max-age=31536000, immutable";

  private readonly gzip = promisify(zlib.gzip);

  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    redisManager: RedisManagerService,
  ) {
    this.redis = redisManager.getConnection("relay");
  }

  public async removeBroadcast(matchId: string) {
    const token = await this.currentToken(matchId);
    if (token) {
      await this.clearBroadcast(matchId, token);
    }
    await this.redis.del(MatchRelayService.tokenKey(matchId));
  }

  // How long a client keeps playing after the game server stops posting: it is
  // SYNC_LAG_FRAGMENTS behind the last fragment, plus that fragment itself.
  // keyframe_interval is the fragment length the game server announced in start.
  public async playoutSeconds(matchId: string): Promise<number> {
    const token = await this.currentToken(matchId);
    const start = token ? await this.readStartMeta(matchId, token) : null;
    const keyframeInterval = Number(start?.keyframe_interval);

    if (!(keyframeInterval > 0)) {
      return 0;
    }

    return (MatchRelayService.SYNC_LAG_FRAGMENTS + 1) * keyframeInterval;
  }

  public async getStart(
    response: Response,
    matchId: string,
    fragmentIndex: number,
  ) {
    const token = await this.currentToken(matchId);
    const [meta, data] = token
      ? await Promise.all([
          this.readStartMeta(matchId, token),
          this.redis.hgetBuffer(
            MatchRelayService.startKey(matchId, token),
            "data",
          ),
        ])
      : [null, null];

    if (meta == null || meta.signup_fragment != fragmentIndex) {
      return this.relayError(
        response,
        404,
        "Invalid or expired start fragment, please re-sync",
      );
    }

    this.serveBlob(response, data, meta);
  }

  // A token in the url pins the request to one broadcast, which is what makes
  // the fragment safe to cache: indexes start over when a new map starts a new
  // broadcast, so the same url without a token can name different data.
  public async getFragment(
    response: Response,
    matchId: string,
    fragmentIndex: number,
    field: FragmentField,
    token?: string,
  ) {
    const currentToken = await this.currentToken(matchId);

    if (!currentToken) {
      this.relayError(response, 404, `broadcast not found`, token);
      return;
    }

    if (token !== undefined && token !== currentToken) {
      this.relayError(
        response,
        404,
        `broadcast has moved on, please re-sync`,
        token,
      );
      return;
    }

    const fragmentKey = MatchRelayService.fragmentKey(
      matchId,
      currentToken,
      fragmentIndex,
    );
    const [metaJson, data] = await Promise.all([
      this.redis.hget(fragmentKey, `${field}_meta`),
      this.redis.hgetBuffer(fragmentKey, field),
    ]);

    if (!metaJson || !data) {
      this.relayError(response, 404, "fragment not found", token);
      return;
    }

    this.serveBlob(
      response,
      data,
      JSON.parse(metaJson),
      token ? MatchRelayService.IMMUTABLE : undefined,
    );
  }

  public async getSyncInfo(
    request: Request,
    response: Response,
    matchId: string,
  ): Promise<void> {
    const nowMs = Date.now();
    response.setHeader("Cache-Control", "public, max-age=3");
    response.setHeader("Expires", new Date(nowMs + 3000).toUTCString());

    const token = await this.currentToken(matchId);

    if (!token) {
      this.relayError(response, 404, `broadcast not found`);
      return;
    }

    const [start, hasStartData, indexes] = await Promise.all([
      this.readStartMeta(matchId, token),
      this.redis.hexists(MatchRelayService.startKey(matchId, token), "data"),
      this.redis.zrange(MatchRelayService.indexKey(matchId, token), 0, -1),
    ]);

    if (start == null || !hasStartData) {
      this.relayError(response, 404, `broadcast has not started yet`);
      return;
    }

    response.setHeader("X-Broadcast-Token", token);

    const fragments = await this.readFragmentMetas(
      matchId,
      token,
      indexes.map(Number),
    );
    const signupFragment = start.signup_fragment || 0;
    const maxIndex = fragments.length
      ? fragments[fragments.length - 1].index
      : 0;

    let fragmentIndex: number;
    let fragment: (typeof fragments)[number] | undefined;
    const fragmentParam = request.query.fragment as string | undefined;

    if (fragmentParam == null) {
      fragmentIndex = Math.max(
        0,
        maxIndex - MatchRelayService.SYNC_LAG_FRAGMENTS,
      );

      if (fragmentIndex >= signupFragment) {
        fragment = fragments.find(
          (candidate) =>
            candidate.index === fragmentIndex &&
            MatchRelayService.isSyncReady(candidate),
        );
      }
    } else {
      fragmentIndex = Math.max(parseInt(fragmentParam), signupFragment);
      fragment = fragments.find(
        (candidate) =>
          candidate.index >= fragmentIndex &&
          MatchRelayService.isSyncReady(candidate),
      );
      fragmentIndex = fragment?.index ?? fragmentIndex;
    }

    if (!fragment) {
      this.relayError(
        response,
        405,
        `fragment not found, please check back soon`,
      );
      return;
    }

    const lastFragment = fragments[fragments.length - 1];
    const endTick = [...fragments]
      .reverse()
      .find((candidate) => candidate.delta?.endtick != null)?.delta?.endtick;

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        tick: fragment.full?.tick,
        endtick: fragment.delta?.endtick,
        maxtick: endTick ?? 0,
        rtdelay: (nowMs - (fragment.delta?.timestamp || nowMs)) / 1000,
        rcvage: (nowMs - (lastFragment?.delta?.timestamp || nowMs)) / 1000,
        fragment: fragmentIndex,
        signup_fragment: start.signup_fragment,
        tps: start.tps,
        keyframe_interval: start.keyframe_interval,
        map: start.map,
        protocol: start.protocol ?? 5,
      }),
    );
  }

  // Answers only once the field is stored: a 200 tells the game server it can
  // move on, and a failed write has to come back as an error instead.
  public async postField(
    request: Request,
    response: Response,
    token: string,
    field: FragmentField,
    matchId: string,
    fragmentIndex: number,
  ): Promise<void> {
    await this.claimBroadcast(matchId, token);

    const startKey = MatchRelayService.startKey(matchId, token);

    // 205 makes the server re-send start, so it also covers a start whose body hasn't landed.
    if (field != "start" && !(await this.redis.hexists(startKey, "data"))) {
      response.writeHead(205);
      response.end();
      return;
    }

    const meta: FieldMeta = {};
    Object.entries(request.query).forEach(([key, value]) => {
      meta[key] = MatchRelayService.parseQueryValue(key, value);
    });

    const body = await MatchRelayService.readBody(request);

    let data = body;
    try {
      data = await this.gzip(body);
      meta.gipped = true;
    } catch (error) {
      this.logger.error(`cannot gzip: ${error}`);
      meta.gipped = false;
    }
    meta.timestamp = Date.now();

    const write = this.redis.multi();

    if (field === "start") {
      meta.signup_fragment = fragmentIndex;
      write
        .del(startKey)
        .hset(startKey, { meta: JSON.stringify(meta), data })
        .expire(startKey, MatchRelayService.BROADCAST_TTL_SECONDS);
    } else {
      const fragmentKey = MatchRelayService.fragmentKey(
        matchId,
        token,
        fragmentIndex,
      );
      const indexKey = MatchRelayService.indexKey(matchId, token);
      write
        .hset(fragmentKey, {
          [`${field}_meta`]: JSON.stringify(meta),
          [field]: data,
        })
        .expire(fragmentKey, MatchRelayService.FRAGMENT_TTL_SECONDS)
        .zadd(indexKey, fragmentIndex, String(fragmentIndex))
        .zremrangebyscore(
          indexKey,
          "-inf",
          `(${fragmentIndex - MatchRelayService.INDEX_WINDOW}`,
        )
        .expire(indexKey, MatchRelayService.BROADCAST_TTL_SECONDS)
        .expire(startKey, MatchRelayService.BROADCAST_TTL_SECONDS);
    }

    const results = await write.exec();
    if (!results) {
      throw new Error("relay write was aborted");
    }
    for (const [error] of results) {
      if (error) {
        throw error;
      }
    }

    response.writeHead(200);
    response.end();
  }

  private currentToken(matchId: string) {
    return this.redis.get(MatchRelayService.tokenKey(matchId));
  }

  // A left-over key from the previous broadcast can only ever be read under its
  // own token, so a clear that fails leaves nothing wrong behind: the keys
  // simply expire.
  private async claimBroadcast(matchId: string, token: string) {
    const previous = await this.redis.set(
      MatchRelayService.tokenKey(matchId),
      token,
      "EX",
      MatchRelayService.BROADCAST_TTL_SECONDS,
      "GET",
    );

    if (previous !== null && previous !== token) {
      await this.clearBroadcast(matchId, previous).catch((error) => {
        this.logger.warn(
          `[${matchId}] could not clear the previous broadcast: ${
            (error as Error)?.message
          }`,
        );
      });
    }
  }

  private async clearBroadcast(matchId: string, token: string) {
    const indexKey = MatchRelayService.indexKey(matchId, token);
    const indexes = await this.redis.zrange(indexKey, 0, -1);

    await this.redis.del(
      MatchRelayService.startKey(matchId, token),
      indexKey,
      ...indexes.map((index) =>
        MatchRelayService.fragmentKey(matchId, token, Number(index)),
      ),
    );
  }

  private async readStartMeta(
    matchId: string,
    token: string,
  ): Promise<FieldMeta | null> {
    const meta = await this.redis.hget(
      MatchRelayService.startKey(matchId, token),
      "meta",
    );
    return meta ? JSON.parse(meta) : null;
  }

  // Only the metadata: whether a fragment is sync-ready is decided from it, and
  // it is written in the same step as the data it describes.
  private async readFragmentMetas(
    matchId: string,
    token: string,
    indexes: Array<number>,
  ) {
    if (indexes.length === 0) {
      return [];
    }

    const pipeline = this.redis.pipeline();
    for (const index of indexes) {
      pipeline.hmget(
        MatchRelayService.fragmentKey(matchId, token, index),
        "full_meta",
        "delta_meta",
      );
    }

    const results = (await pipeline.exec()) ?? [];

    return indexes
      .map((index, position) => {
        const [fullMeta, deltaMeta] = (results[position]?.[1] ?? []) as [
          string | null,
          string | null,
        ];
        return {
          index,
          full: fullMeta ? (JSON.parse(fullMeta) as FieldMeta) : undefined,
          delta: deltaMeta ? (JSON.parse(deltaMeta) as FieldMeta) : undefined,
        };
      })
      .filter((fragment) => fragment.full || fragment.delta);
  }

  private static isSyncReady(fragment: {
    full?: FieldMeta;
    delta?: FieldMeta;
  }): boolean {
    return (
      fragment.full != null &&
      fragment.delta != null &&
      (fragment.full.tick != null || fragment.delta.tick != null) &&
      fragment.delta.endtick != null &&
      fragment.delta.timestamp != null
    );
  }

  private static async readBody(request: Request): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private static tokenKey(matchId: string) {
    return `match-relay:${matchId}:token`;
  }

  private static startKey(matchId: string, token: string) {
    return `match-relay:${matchId}:${token}:start`;
  }

  private static indexKey(matchId: string, token: string) {
    return `match-relay:${matchId}:${token}:fragments`;
  }

  private static fragmentKey(matchId: string, token: string, index: number) {
    return `match-relay:${matchId}:${token}:fragment:${index}`;
  }

  // Clients read /sync's tick, tps, etc. as JSON numbers, as Valve's reference relay sends them.
  private static parseQueryValue(key: string, value: unknown) {
    if (
      typeof value !== "string" ||
      !MatchRelayService.NUMERIC_QUERY_FIELDS.includes(key) ||
      !/^\d+(?:\.\d+)?$/.test(value)
    ) {
      return value;
    }

    return Number(value);
  }

  // A token-scoped miss must never be cached: the fragment may simply not have
  // arrived yet.
  private relayError(
    response: Response,
    code: number,
    explanation: string,
    token?: string,
  ): void {
    const headers: Record<string, string> = { "X-Reason": explanation };
    if (token) {
      headers["Cache-Control"] = "no-store";
    }
    response.writeHead(code, headers);
    response.end();
  }

  private serveBlob(
    response: Response,
    blob: Buffer | null,
    meta: FieldMeta,
    cacheControl?: string,
  ): void {
    if (!blob) {
      response.writeHead(404, "Field not found");
      response.end();
      return;
    }

    const headers: { [key: string]: string } = {
      "Content-Type": "application/octet-stream",
    };
    if (meta.gipped) {
      headers["Content-Encoding"] = "gzip";
    }
    if (cacheControl) {
      headers["Cache-Control"] = cacheControl;
    }
    response.writeHead(200, headers);
    response.end(blob);
  }
}
