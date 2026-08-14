import { Injectable, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { PostgresService } from "../../postgres/postgres.service";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import { RconService } from "../../rcon/rcon.service";
import { MediaMtxService } from "../../mediamtx/mediamtx.service";
import { SocketsService } from "../../sockets/sockets.service";
import { CameraService, type CameraHealth } from "./camera.service";

// How long a camera may be anything other than `live` before the match is
// paused. Long enough to ride out a WebRTC renegotiation, a wifi blip or a
// phone locking its screen; short enough to catch a real drop inside a round.
const GRACE_MS = 30_000;

type PlayerSample = {
  bytes: number;
  // When this player was last observed healthy. The grace window is measured
  // from here, so a feed that flaps never resets its way out of a pause.
  healthyAt: number;
  health: CameraHealth;
};

type MonitoredPlayer = {
  steamId: string;
  name: string | null;
  health: CameraHealth;
  offline: boolean;
};

@Injectable()
export class CameraMonitorService {
  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly rcon: RconService,
    private readonly mediaMtx: MediaMtxService,
    private readonly sockets: SocketsService,
    redisManager: RedisManagerService,
  ) {
    this.redis = redisManager.getConnection();
  }

  private static samplesKey(matchId: string) {
    return `camera:samples:${matchId}`;
  }

  private static reportedKey(matchId: string) {
    return `camera:reported:${matchId}`;
  }

  public async monitorLiveMatches(now = Date.now()) {
    // Coaches are included, but on different terms -- see monitorMatch. A
    // player is only watched once they are in the server (`is_connected`), and
    // a coach has no equivalent of that, so the query cannot filter them the
    // same way and the attendance rule lives downstream instead.
    const rows = await this.postgres.query<
      Array<{
        match_id: string;
        server_id: string | null;
        steam_id: string;
        name: string | null;
        coach: boolean;
      }>
    >(
      `SELECT m.id AS match_id,
              m.server_id::text AS server_id,
              mlp.steam_id::text AS steam_id,
              p.name,
              false AS coach
       FROM matches m
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       INNER JOIN match_lineup_players mlp
         ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
       LEFT JOIN players p ON p.steam_id = mlp.steam_id
       WHERE m.status = 'Live'
         AND mo.camera_required = true
         AND m.server_id IS NOT NULL
         AND mlp.steam_id IS NOT NULL
         AND mlp.is_connected = true

       UNION ALL

       SELECT m.id AS match_id,
              m.server_id::text AS server_id,
              ml.coach_steam_id::text AS steam_id,
              p.name,
              true AS coach
       FROM matches m
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       INNER JOIN match_lineups ml
         ON ml.id IN (m.lineup_1_id, m.lineup_2_id)
       LEFT JOIN players p ON p.steam_id = ml.coach_steam_id
       WHERE m.status = 'Live'
         AND mo.camera_required = true
         AND m.server_id IS NOT NULL
         AND ml.coach_steam_id IS NOT NULL`,
    );

    if (rows.length === 0) {
      return;
    }

    // One list call covers every camera on the box, however many matches are
    // live — a per-player status request would scale with the roster.
    const paths = await this.mediaMtx.listPaths();

    // Fail open. If MediaMTX is unreachable we cannot tell a dead camera from
    // a dead monitor, and pausing every live match on our own outage is far
    // worse than missing a drop.
    if (!paths) {
      this.logger.warn(
        "[camera] skipping monitor pass: mediamtx did not answer",
      );
      return;
    }

    const byMatch = new Map<
      string,
      {
        serverId: string;
        players: Array<{
          steamId: string;
          name: string | null;
          coach: boolean;
        }>;
      }
    >();

    for (const row of rows) {
      if (!row.server_id) {
        continue;
      }

      const match = byMatch.get(row.match_id) ?? {
        serverId: row.server_id,
        players: [],
      };
      match.players.push({
        steamId: row.steam_id,
        name: row.name,
        coach: row.coach === true,
      });
      byMatch.set(row.match_id, match);
    }

    for (const [matchId, { serverId, players }] of byMatch) {
      await this.monitorMatch(matchId, serverId, players, paths, now);
    }
  }

  private async monitorMatch(
    matchId: string,
    serverId: string,
    players: Array<{ steamId: string; name: string | null; coach: boolean }>,
    paths: Map<string, { ready: boolean; bytesReceived: number }>,
    now: number,
  ) {
    const samplesKey = CameraMonitorService.samplesKey(matchId);
    const stored = await this.redis.hgetall(samplesKey);
    const nextSamples: Record<string, string> = {};
    const monitored: Array<MonitoredPlayer> = [];

    for (const { steamId, name, coach } of players) {
      const path = paths.get(CameraService.pathForPlayer(matchId, steamId));
      const previous = CameraMonitorService.parseSample(stored[steamId]);

      // A coach is watched from the moment they first appear on camera, and not
      // before. `is_connected` says a player is in the server; a coach has no
      // such signal, so their own camera is the attendance record. Without this
      // an assigned-but-absent coach -- a very ordinary thing -- would hold a
      // match paused from the first pass and nobody could start it.
      if (coach && !previous && !path?.ready) {
        continue;
      }

      let health: CameraHealth;
      if (!path?.ready) {
        health = "down";
      } else if (!previous || path.bytesReceived > previous.bytes) {
        health = "live";
      } else {
        // The path is up but nothing has arrived since the last pass: a
        // suspended tab or a dead uplink whose session has not torn down yet.
        health = "stalled";
      }

      const healthyAt = health === "live" ? now : (previous?.healthyAt ?? now);

      nextSamples[steamId] =
        `${path?.bytesReceived ?? 0}:${healthyAt}:${health}`;

      monitored.push({
        steamId,
        name,
        health,
        offline: health !== "live" && now - healthyAt >= GRACE_MS,
      });
    }

    // hset errors on an empty payload, and an empty pass is ordinary: a match
    // flips Live with nobody connected yet and an assigned coach not on camera.
    if (Object.keys(nextSamples).length > 0) {
      await this.redis.hset(samplesKey, nextSamples);
      await this.redis.expire(samplesKey, 3600);
    }

    await this.reportToServer(matchId, serverId, monitored);
  }

  // Edge-triggered: the plugin owns the pause, so it only needs to hear when
  // the offending set actually changes, not once every pass.
  private async reportToServer(
    matchId: string,
    serverId: string,
    monitored: Array<MonitoredPlayer>,
  ) {
    const offenders = monitored
      .filter((player) => player.offline)
      .map((player) => player.steamId)
      .sort();

    const payload = offenders.join(",");
    const reportedKey = CameraMonitorService.reportedKey(matchId);
    // No key means nothing is currently reported, which is the same state as an
    // empty payload — without collapsing the two, a healthy match would be sent
    // a redundant all-clear on every pass.
    const reported = (await this.redis.get(reportedKey)) ?? "";

    if (reported === payload) {
      return;
    }

    // Tell every watching surface to re-read now rather than wait out its poll.
    // Deliberately carries no player data: this reaches all connected clients,
    // so the actual status still has to be fetched through the authorized
    // endpoint. Emitted before the rcon call so the UI still updates when the
    // game server is unreachable.
    void this.sockets.broadcastToCluster("camera-status", { matchId }).catch(
      (error: unknown): void => {
        this.logger.warn(
          `[${matchId}] failed to push camera status: ${(error as Error)?.message ?? error}`,
        );
      },
    );

    const rcon = await this.rcon.connect(serverId);

    if (!rcon) {
      this.logger.warn(
        `[${matchId}] camera state changed but rcon is unavailable; will retry next pass`,
      );
      return;
    }

    await rcon.send(`camera_state ${payload}`);

    if (payload) {
      await this.redis.setex(reportedKey, 3600, payload);
      this.logger.log(
        `[${matchId}] cameras offline: ${offenders.join(", ")} — asked the server to pause`,
      );
      return;
    }

    await this.redis.del(reportedKey);
    this.logger.log(`[${matchId}] all cameras restored`);
  }

  public async clearMatch(matchId: string) {
    await this.redis.del(
      CameraMonitorService.samplesKey(matchId),
      CameraMonitorService.reportedKey(matchId),
    );
  }

  // The health of every camera on a match as of the last pass, for callers that
  // report state rather than decide it (the game-server payload, the admin grid).
  public async healthFor(matchId: string) {
    const stored = await this.redis.hgetall(
      CameraMonitorService.samplesKey(matchId),
    );
    const health = new Map<string, CameraHealth>();

    for (const [steamId, raw] of Object.entries(stored)) {
      const sample = CameraMonitorService.parseSample(raw);

      if (sample) {
        health.set(steamId, sample.health);
      }
    }

    return health;
  }

  private static parseSample(raw?: string): PlayerSample | null {
    if (!raw) {
      return null;
    }

    const [bytes, healthyAt, health] = raw.split(":");
    const parsedBytes = Number(bytes);
    const parsedHealthyAt = Number(healthyAt);

    if (!Number.isFinite(parsedBytes) || !Number.isFinite(parsedHealthyAt)) {
      return null;
    }

    return {
      bytes: parsedBytes,
      healthyAt: parsedHealthyAt,
      health: health === "live" || health === "stalled" ? health : "down",
    };
  }
}
