import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";
import { MediaMtxService } from "../../mediamtx/mediamtx.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { GameStreamerService } from "../game-streamer/game-streamer.service";
import { User } from "../../auth/types/User";
import { isRoleAbove } from "../../utilities/isRoleAbove";

// A token is only meaningful while the match is actually being played, so a
// leaked link stops working on its own without needing an expiry column.
const CAMERA_ACTIVE_MATCH_STATUSES = [
  "WaitingForCheckIn",
  "Veto",
  "Live",
  "WaitingForServer",
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Steam64. Digits-only is the part that matters: these values are interpolated
// into a MediaMTX path, and anything containing a separator could address a
// path other than the one the caller was authorized for.
const STEAM_ID_PATTERN = /^\d{17}$/;

export type CameraTokenLookup = {
  matchId: string;
  steamId: string;
};

const NOT_AUTHORIZED = "not authorized to view cameras for this match";

// "all" is both lineups; "lineup" is a competitor seeing only their own side.
export type CameraScope =
  | { kind: "all" }
  | { kind: "lineup"; lineupId: string };

export type CameraHealth = "live" | "stalled" | "down";

export type CameraPlayerStatus = {
  steamId: string;
  name: string | null;
  // Surfaces do not all have the player row to hand -- the stream deck keys off
  // GSI, which carries no avatar -- so it rides along with the camera status.
  avatarUrl: string | null;
  lineupId: string;
  ready: boolean;
  // "stalled" is a path that is still up but has stopped delivering — it looks
  // identical to a working camera in the grid unless we say so.
  health: CameraHealth;
};

@Injectable()
export class CameraService {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly mediaMtx: MediaMtxService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly gameStreamer: GameStreamerService,
  ) {}

  public static pathForPlayer(matchId: string, steamId: string) {
    return `camera-${matchId}-${steamId}`;
  }

  // A call rides its own path so that starting or ending one never disturbs
  // the player's required camera publish.
  public static talkPathForPlayer(matchId: string, steamId: string) {
    return `camera-talk-${matchId}-${steamId}`;
  }

  public async generateTokensIfRequired(matchId: string) {
    const rows = await this.postgres.query<
      Array<{ camera_required: boolean; steam_id: string | null }>
    >(
      `SELECT mo.camera_required, mlp.steam_id::text AS steam_id
       FROM matches m
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       LEFT JOIN match_lineup_players mlp
         ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
        AND mlp.steam_id IS NOT NULL
       WHERE m.id = $1`,
      [matchId],
    );

    if (rows.length === 0 || !rows[0].camera_required) {
      return;
    }

    const steamIds = rows
      .map((row) => row.steam_id)
      .filter((steamId): steamId is string => Boolean(steamId));

    if (steamIds.length === 0) {
      this.logger.warn(
        `[${matchId}] camera_required is on but the lineups are empty; not minting tokens`,
      );
      return;
    }

    // Idempotent: the Live edge can fire more than once for one match.
    await this.postgres.query(
      `INSERT INTO match_camera_tokens (match_id, steam_id)
       SELECT $1, unnest($2::bigint[])
       ON CONFLICT (match_id, steam_id) DO NOTHING`,
      [matchId, steamIds],
    );
  }

  // Whether this player's own camera is publishing right now. Used to gate
  // check-in, which happens before the monitor starts sampling.
  public async isPlayerLive(matchId: string, steamId: string) {
    return this.mediaMtx.isPathReady(
      CameraService.pathForPlayer(matchId, steamId),
    );
  }

  public async isRequired(matchId: string) {
    const [row] = await this.postgres.query<
      Array<{ camera_required: boolean }>
    >(
      `SELECT mo.camera_required
       FROM matches m
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       WHERE m.id = $1`,
      [matchId],
    );

    return row?.camera_required === true;
  }

  public async revokeTokens(matchId: string) {
    await this.postgres.query(
      `DELETE FROM match_camera_tokens WHERE match_id = $1`,
      [matchId],
    );
  }

  public async validateToken(token: string): Promise<CameraTokenLookup | null> {
    // The column is a uuid, so anything else (a stray URL, someone probing the
    // endpoint) would reach Postgres and fail as a 500 rather than a clean miss.
    if (!token || !UUID_PATTERN.test(token)) {
      return null;
    }

    const [row] = await this.postgres.query<
      Array<{ match_id: string; steam_id: string; status: string }>
    >(
      `SELECT t.match_id, t.steam_id::text AS steam_id, m.status
       FROM match_camera_tokens t
       INNER JOIN matches m ON m.id = t.match_id
       WHERE t.token = $1
       LIMIT 1`,
      [token],
    );

    if (!row || !CAMERA_ACTIVE_MATCH_STATUSES.includes(row.status)) {
      return null;
    }

    return { matchId: row.match_id, steamId: row.steam_id };
  }

  // Site admins, or an organizer of this specific match — deliberately not the
  // global tournament_organizer role, which would open every tournament's
  // cameras rather than just this one.
  // Who may watch, and whose cameras. Nobody playing the match can watch any of
  // it -- not even an administrator -- because a live view of the other side is
  // exactly the advantage this feature exists to prevent.
  public async watchScope(matchId: string, user: User): Promise<CameraScope> {
    if (!UUID_PATTERN.test(matchId)) {
      throw new Error(NOT_AUTHORIZED);
    }

    const [row] = await this.postgres.query<
      Array<{
        my_lineup_id: string | null;
        allow_teammates: boolean;
      }>
    >(
      `SELECT mo.camera_allow_teammates AS allow_teammates,
              (
                SELECT mlp.match_lineup_id::text
                FROM match_lineup_players mlp
                WHERE mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                  AND mlp.steam_id = $2
                LIMIT 1
              ) AS my_lineup_id
       FROM matches m
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       WHERE m.id = $1`,
      [matchId, user.steam_id],
    );

    if (!row) {
      throw new Error(NOT_AUTHORIZED);
    }

    if (row.my_lineup_id) {
      // Deliberate exception to "nobody playing may watch": a site
      // administrator keeps full access so the feature can be exercised
      // end-to-end without a second account. Organizers playing stay scoped to
      // their own side -- they are competitors, and a live view of the other
      // team is the advantage this exists to prevent.
      if (isRoleAbove(user.role, "administrator")) {
        return { kind: "all" };
      }

      // A player only ever sees their own side, and only when the match was set
      // up to allow it. The opposing side is never visible to a competitor.
      if (!row.allow_teammates) {
        throw new Error(NOT_AUTHORIZED);
      }

      return { kind: "lineup", lineupId: row.my_lineup_id };
    }

    if (isRoleAbove(user.role, "administrator")) {
      return { kind: "all" };
    }

    const isOrganizer = await this.matchAssistant
      .isOrganizer(matchId, user)
      .catch(() => false);

    if (!isOrganizer) {
      throw new Error(NOT_AUTHORIZED);
    }

    return { kind: "all" };
  }

  private async assertCanWatchPlayer(
    matchId: string,
    steamId: string,
    user: User,
  ) {
    if (!STEAM_ID_PATTERN.test(steamId)) {
      throw new Error(NOT_AUTHORIZED);
    }

    const scope = await this.watchScope(matchId, user);

    if (scope.kind === "all") {
      return;
    }

    const [row] = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT true AS exists
       FROM match_lineup_players
       WHERE match_lineup_id = $1 AND steam_id = $2
       LIMIT 1`,
      [scope.lineupId, steamId],
    );

    if (!row) {
      throw new Error(NOT_AUTHORIZED);
    }
  }

  // The broadcast pod has no site session — it authenticates as the match
  // itself, the same scheme status-reporter and snapshot already use. Scoped to
  // one match, and only to players actually on that match's roster.
  public async proxyBroadcastWatch(
    matchId: string,
    steamId: string,
    originAuth: unknown,
    sdp: string,
  ) {
    if (!UUID_PATTERN.test(matchId) || !STEAM_ID_PATTERN.test(steamId)) {
      throw new Error(NOT_AUTHORIZED);
    }

    const authorized = await this.gameStreamer.validateStatusOriginAuth(
      matchId,
      originAuth,
    );

    if (!authorized) {
      throw new Error(NOT_AUTHORIZED);
    }

    const [row] = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT true AS exists
       FROM matches m
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       INNER JOIN match_lineup_players mlp
         ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
       WHERE m.id = $1
         AND mlp.steam_id = $2
         AND mo.camera_required = true
       LIMIT 1`,
      [matchId, steamId],
    );

    if (!row) {
      throw new Error(NOT_AUTHORIZED);
    }

    return this.mediaMtx.proxySdp(
      CameraService.pathForPlayer(matchId, steamId),
      "whep",
      sdp,
    );
  }

  public async proxyPlayerPublish(token: string, sdp: string) {
    const lookup = await this.requireToken(token);

    return this.mediaMtx.proxySdp(
      CameraService.pathForPlayer(lookup.matchId, lookup.steamId),
      "whip",
      sdp,
    );
  }

  public async getPlayerStatus(token: string) {
    const lookup = await this.validateToken(token);

    if (!lookup) {
      return { ready: false };
    }

    return {
      ready: await this.mediaMtx.isPathReady(
        CameraService.pathForPlayer(lookup.matchId, lookup.steamId),
      ),
    };
  }

  public async proxyAdminWatch(
    matchId: string,
    steamId: string,
    user: User,
    sdp: string,
  ) {
    await this.assertCanWatchPlayer(matchId, steamId, user);

    return this.mediaMtx.proxySdp(
      CameraService.pathForPlayer(matchId, steamId),
      "whep",
      sdp,
    );
  }

  public async proxyAdminTalk(
    matchId: string,
    steamId: string,
    user: User,
    sdp: string,
  ) {
    await this.assertCanWatchPlayer(matchId, steamId, user);

    return this.mediaMtx.proxySdp(
      CameraService.talkPathForPlayer(matchId, steamId),
      "whip",
      sdp,
    );
  }

  public async proxyPlayerTalk(token: string, sdp: string) {
    const lookup = await this.requireToken(token);

    return this.mediaMtx.proxySdp(
      CameraService.talkPathForPlayer(lookup.matchId, lookup.steamId),
      "whep",
      sdp,
    );
  }

  public async getPlayerTalkStatus(token: string) {
    const lookup = await this.validateToken(token);

    if (!lookup) {
      return { ready: false };
    }

    return {
      ready: await this.mediaMtx.isPathReady(
        CameraService.talkPathForPlayer(lookup.matchId, lookup.steamId),
      ),
    };
  }

  public async getAdminTalkStatus(matchId: string, steamId: string, user: User) {
    await this.assertCanWatchPlayer(matchId, steamId, user);

    return {
      ready: await this.mediaMtx.isPathReady(
        CameraService.talkPathForPlayer(matchId, steamId),
      ),
    };
  }

  public async hangupAdminTalk(matchId: string, steamId: string, user: User) {
    await this.assertCanWatchPlayer(matchId, steamId, user);

    await this.mediaMtx.kickSessions(
      CameraService.talkPathForPlayer(matchId, steamId),
    );
  }

  public async hangupPlayerTalk(token: string) {
    const lookup = await this.validateToken(token);

    if (!lookup) {
      return;
    }

    await this.mediaMtx.kickSessions(
      CameraService.talkPathForPlayer(lookup.matchId, lookup.steamId),
    );
  }

  public async getPlayersWithCameraStatus(
    matchId: string,
    user: User,
    health: Map<string, CameraHealth>,
  ) {
    const scope = await this.watchScope(matchId, user);

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        lineup_1: {
          id: true,
          name: true,
          team_id: true,
          team: {
            roster: {
              player_steam_id: true,
              roster_image_url: true,
            },
          },
          lineup_players: {
            steam_id: true,
            player: {
              name: true,
              avatar_url: true,
            },
          },
        },
        lineup_2: {
          id: true,
          name: true,
          team_id: true,
          team: {
            roster: {
              player_steam_id: true,
              roster_image_url: true,
            },
          },
          lineup_players: {
            steam_id: true,
            player: {
              name: true,
              avatar_url: true,
            },
          },
        },
      },
    });

    if (!match?.lineup_1 || !match?.lineup_2) {
      throw new Error("match lineups not found");
    }

    // A competitor is handed only their own side. Returning the other lineup
    // and hiding it in the client would still ship the roster over the wire.
    const visible = [match.lineup_1, match.lineup_2].filter((lineup) => {
      return scope.kind === "all" || lineup.id === scope.lineupId;
    });

    const lineups = await Promise.all(
      visible.map((lineup) =>
        this.lineupWithCameraStatus(matchId, lineup, health),
      ),
    );

    return { lineups };
  }

  private async requireToken(token: string) {
    const lookup = await this.validateToken(token);

    if (!lookup) {
      throw new Error("invalid or expired camera link");
    }

    return lookup;
  }

  private async lineupWithCameraStatus(
    matchId: string,
    lineup: {
      id: string;
      name: string;
      team_id?: string | null;
      team?: {
        roster?: Array<{
          player_steam_id: string | number;
          roster_image_url?: string | null;
        }> | null;
      } | null;
      lineup_players?: Array<{
        steam_id: string;
        player?: { name?: string | null; avatar_url?: string | null } | null;
      }>;
    },
    health: Map<string, CameraHealth>,
  ) {
    // A team's roster image wins over the player's own steam avatar, matching
    // what every other roster surface shows. Resolved here rather than per
    // client because the stream deck keys off GSI and never loads the team.
    const rosterImages = new Map<string, string>();

    if (lineup.team_id) {
      for (const entry of lineup.team?.roster ?? []) {
        if (entry.roster_image_url) {
          rosterImages.set(String(entry.player_steam_id), entry.roster_image_url);
        }
      }
    }

    return {
      id: lineup.id,
      name: lineup.name,
      players: await Promise.all(
        (lineup.lineup_players ?? []).map(async (lineupPlayer) => {
          const ready = await this.mediaMtx.isPathReady(
            CameraService.pathForPlayer(matchId, lineupPlayer.steam_id),
          );

          return {
            steamId: lineupPlayer.steam_id,
            name: lineupPlayer.player?.name ?? null,
            avatarUrl:
              rosterImages.get(String(lineupPlayer.steam_id)) ??
              lineupPlayer.player?.avatar_url ??
              null,
            lineupId: lineup.id,
            ready,
            // Fall back to the live path check when the monitor has no sample:
            // it only runs for Live matches, and the grid opens during veto too.
            health:
              health.get(String(lineupPlayer.steam_id)) ??
              (ready ? "live" : "down"),
          } satisfies CameraPlayerStatus;
        }),
      ),
    };
  }
}
