import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";
import { RconService } from "../rcon/rcon.service";
import { User } from "../auth/types/User";

/** Where a player is right now, and which session owns that server. */
export type UtilityPlayerLocation = {
  server_id: string;
  session_id: string;
  map_name: string;
};

/**
 * A lineup the panel has sent to a server that the player's own library would
 * not otherwise contain. Two shapes, one mechanism:
 *
 *  - `saved` is an id. A Public lineup nobody has favourited is not in anyone's
 *    library, so sending one has to widen that player's library by exactly one
 *    row rather than by a whole visibility class.
 *  - `scratch` is a throw with no row behind it at all -- a mined meta spot
 *    somebody wants to stand on before deciding whether it is worth writing up.
 */
export type UtilityPendingLineup =
  | { kind: "saved"; lineup_id: string }
  | { kind: "scratch"; lineup: UtilityScratchLineup };

export type UtilityScratchLineup = {
  client_id: string;
  name: string;
  map_name: string;
  utility_type: string;
  side: string;
  technique: string;
  throw_strength: string;
  origin_x: number;
  origin_y: number;
  origin_z: number;
  eye_z: number;
  view_yaw: number;
  view_pitch: number;
  land_x: number | null;
  land_y: number | null;
  land_z: number | null;
};

export type UtilityLoadResult = {
  sent: boolean;
  /** Machine-readable so the web can choose between "book a server" and "fix the map". */
  reason:
    | "sent"
    | "not_on_a_server"
    | "wrong_map"
    | "not_visible"
    | "unreachable";
  map_name: string | null;
};

@Injectable()
export class UtilityLoadService {
  /**
   * Long enough to survive a map change and somebody wandering off to make a
   * coffee, short enough that a library does not accumulate every lineup a
   * player ever pressed the button on.
   */
  public static readonly PENDING_SECONDS = 30 * 60;

  /** Nothing is gained by remembering more than this, and a library is a chat reply. */
  private static readonly PENDING_MAX = 25;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    @Inject(forwardRef(() => RconService))
    private readonly rcon: RconService,
  ) {}

  /**
   * The reverse of `reportOccupancy`: that writes `is_connected` per player for
   * the session's match, so the same column answers "which server is this
   * player sitting in" without any new tracking.
   *
   * Only servers running the utility plugin report occupancy, so this is
   * deliberately answering "which practice server", not "which server".
   */
  public async serverForPlayer(
    steamId: string,
  ): Promise<UtilityPlayerLocation | null> {
    const [row] = await this.postgres.query<Array<UtilityPlayerLocation>>(
      `SELECT srv.id::text AS server_id,
              s.id::text AS session_id,
              s.map_name
         FROM public.match_lineup_players mlp
         INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
         INNER JOIN public.matches m ON m.id = ml.match_id
         INNER JOIN public.servers srv ON srv.reserved_by_match_id = m.id
         INNER JOIN public.utility_practice_sessions s ON s.match_id = m.id
        WHERE mlp.steam_id = $1::bigint
          AND mlp.is_connected = true
          AND s.status IN ('Starting', 'Ready')
        LIMIT 1`,
      [steamId],
    );

    return row ?? null;
  }

  /** Stand the caller on a lineup they can see, on the server they are already in. */
  public async sendToLineup(
    user: User,
    lineupId: string,
  ): Promise<UtilityLoadResult> {
    const at = await this.serverForPlayer(user.steam_id);

    if (!at) {
      return { sent: false, reason: "not_on_a_server", map_name: null };
    }

    const [lineup] = await this.postgres.query<
      Array<{ map_name: string; visible: boolean }>
    >(
      `SELECT l.map_name,
              public.can_view_utility_lineup(
                l,
                json_build_object(
                  'x-hasura-user-id', $2::text,
                  'x-hasura-role', $3::text
                )
              ) AS visible
         FROM public.utility_lineups l
        WHERE l.id = $1::uuid`,
      [lineupId, user.steam_id, user.role ?? "user"],
    );

    // Same answer for "no such lineup" and "not yours": the alternative tells a
    // stranger which ids exist.
    if (!lineup?.visible) {
      return { sent: false, reason: "not_visible", map_name: null };
    }

    // A lineup measured on another map would stand you in the middle of
    // nothing, so the map has to match before anything is sent.
    if (lineup.map_name !== at.map_name) {
      return { sent: false, reason: "wrong_map", map_name: lineup.map_name };
    }

    await this.remember(at.server_id, user.steam_id, {
      kind: "saved",
      lineup_id: lineupId,
    });

    return this.dispatch(at, user.steam_id, lineupId, lineup.map_name);
  }

  /**
   * Stand the caller on a throw that has no lineup behind it. This is what lets
   * somebody try a mined meta spot before deciding whether it is worth writing
   * up -- the whole point being that you find out on the server rather than by
   * authoring one and hoping.
   */
  public async sendScratch(
    user: User,
    scratch: UtilityScratchLineup,
  ): Promise<UtilityLoadResult> {
    const at = await this.serverForPlayer(user.steam_id);

    if (!at) {
      return { sent: false, reason: "not_on_a_server", map_name: null };
    }

    if (scratch.map_name !== at.map_name) {
      return { sent: false, reason: "wrong_map", map_name: scratch.map_name };
    }

    await this.remember(at.server_id, user.steam_id, {
      kind: "scratch",
      lineup: scratch,
    });

    return this.dispatch(at, user.steam_id, scratch.client_id, scratch.map_name);
  }

  private async dispatch(
    at: UtilityPlayerLocation,
    steamId: string,
    lineupId: string,
    mapName: string,
  ): Promise<UtilityLoadResult> {
    // The plugin re-reads the library when it does not recognise the id, which
    // is what picks up the entry remembered just above.
    const reply = await this.send(
      at.server_id,
      `utility_practice_load ${steamId} ${lineupId}`,
    );

    if (reply === null) {
      return { sent: false, reason: "unreachable", map_name: mapName };
    }

    this.logger.log(
      `[utility-load] ${steamId} -> ${lineupId} on ${at.server_id}`,
    );

    return { sent: true, reason: "sent", map_name: mapName };
  }

  /** What `GET /utility/library` has to add to this player's own rows. */
  public async pending(
    serverId: string,
    steamId: string,
  ): Promise<Array<UtilityPendingLineup>> {
    const entries = await this.cache.get(
      UtilityLoadService.key(serverId, steamId),
    );

    return Array.isArray(entries) ? (entries as Array<UtilityPendingLineup>) : [];
  }

  private async remember(
    serverId: string,
    steamId: string,
    entry: UtilityPendingLineup,
  ): Promise<void> {
    const key = UtilityLoadService.key(serverId, steamId);
    const existing = await this.pending(serverId, steamId);

    // Re-sending the same lineup must not grow the list, and re-sending a
    // scratch throw has to replace the old one: the client_id is stable per
    // meta spot, so the second send is an edited aim rather than a new throw.
    const id = UtilityLoadService.idOf(entry);
    const next = existing.filter((held) => UtilityLoadService.idOf(held) !== id);

    next.push(entry);

    await this.cache.put(
      key,
      next.slice(-UtilityLoadService.PENDING_MAX),
      UtilityLoadService.PENDING_SECONDS,
    );
  }

  private static idOf(entry: UtilityPendingLineup): string {
    return entry.kind === "saved" ? entry.lineup_id : entry.lineup.client_id;
  }

  private static key(serverId: string, steamId: string): string {
    return `utility:practice:pending:${serverId}:${steamId}`;
  }

  private async send(
    serverId: string,
    command: string,
  ): Promise<string | null> {
    try {
      const connection = await this.rcon.connect(serverId);

      if (!connection) {
        return null;
      }

      return await connection.send(command);
    } catch (error) {
      this.logger.warn(
        `[utility-load] ${serverId} rcon failed: ${(error as Error)?.message}`,
      );
      return null;
    }
  }
}
