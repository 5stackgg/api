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
  // map_name moves the moment a switch is accepted; the level takes another
  // ~15s. Everything that acts on this location has to know it is looking at
  // where the server is GOING rather than where it is.
  switching: boolean;
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

/**
 * The answer to "am I standing on a practice server right now".
 *
 * One shape, built in one place: it is returned by the utilityPracticeWhereAmI
 * action AND pushed over the socket when occupancy changes, and the two
 * disagreeing would show a Practice button for a server the player already left.
 */
export type UtilityWhere = {
  on_server: boolean;
  map_name: string | null;
  session_id: string | null;
  switching: boolean;
};

export type UtilityLoadResult = {
  sent: boolean;
  /** Machine-readable so the web can choose between "book a server" and "fix the map". */
  reason:
    | "sent"
    | "not_on_a_server"
    | "wrong_map"
    | "map_switching"
    | "not_visible"
    | "unreachable"
    | "nothing_to_drill";
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

  // Everything that ends up on an RCON command line goes through here. A saved
  // id is a uuid the database handed back, but a scratch id is the caller's own
  // string -- and the source console splits a command line on ';', so an
  // unchecked one is arbitrary RCON on somebody's practice server. A uuid and a
  // `scratch-<lineup_bucket>` key both live inside this set; nothing else does.
  private static readonly RCON_ID = /^[A-Za-z0-9_.,:-]{1,96}$/;

  private static assertRconId(id: string): void {
    if (!UtilityLoadService.RCON_ID.test(id)) {
      throw Error("that is not a lineup id");
    }
  }

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
              s.map_name,
              s.map_changing_at IS NOT NULL AS switching
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

  /** `serverForPlayer` in the shape the website and the socket push both read. */
  public async whereAmI(steamId: string): Promise<UtilityWhere> {
    const at = await this.serverForPlayer(steamId);

    return {
      on_server: !!at,
      map_name: at?.map_name ?? null,
      session_id: at?.session_id ?? null,
      switching: at?.switching === true,
    };
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

    // Mid-changelevel there is no player on the server to teleport, so the
    // plugin would take this command and silently do nothing while we reported
    // it sent. The queued load the switch itself carries is what lands them.
    if (at.switching) {
      return { sent: false, reason: "map_switching", map_name: at.map_name };
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
   * Drill a set the caller picked, on the server they are already in.
   *
   * Every id is checked the same way a single send is -- visible, and on the
   * map they are standing on -- because a drill is just a queue of the same
   * loads, and skipping the checks for a batch would be the obvious way to
   * make the batch the hole.
   */
  public async sendDrill(
    user: User,
    lineupIds: Array<string>,
  ): Promise<UtilityLoadResult & { queued: number }> {
    const at = await this.serverForPlayer(user.steam_id);

    if (!at) {
      return { sent: false, reason: "not_on_a_server", map_name: null, queued: 0 };
    }

    if (at.switching) {
      return { sent: false, reason: "map_switching", map_name: at.map_name, queued: 0 };
    }

    const ids = [...new Set(lineupIds.filter(Boolean))].slice(
      0,
      UtilityLoadService.MAX_DRILL,
    );

    if (ids.length === 0) {
      return { sent: false, reason: "nothing_to_drill", map_name: null, queued: 0 };
    }

    const allowed = await this.visibleOnMap(user, ids, at.map_name);

    // Order is the caller's, not the database's: they chose the sequence.
    const queue = ids.filter((id) => allowed.has(id));

    if (queue.length === 0) {
      return { sent: false, reason: "wrong_map", map_name: at.map_name, queued: 0 };
    }

    for (const id of queue) {
      await this.remember(at.server_id, user.steam_id, {
        kind: "saved",
        lineup_id: id,
      });
    }

    const reply = await this.send(
      at.server_id,
      `utility_practice_drill ${user.steam_id} ${queue.join(",")}`,
    );

    if (reply === null) {
      return { sent: false, reason: "unreachable", map_name: at.map_name, queued: 0 };
    }

    this.logger.log(
      `[utility-load] ${user.steam_id} -> drill of ${queue.length} on ${at.server_id}`,
    );

    return { sent: true, reason: "sent", map_name: at.map_name, queued: queue.length };
  }

  // A drill is a queue of teleports; a thousand of them is a denial of service
  // with extra steps.
  public static readonly MAX_DRILL = 50;

  /**
   * Which of these lineups this player may be stood on, on this map.
   *
   * The map is a parameter rather than "the map they are on" because a map
   * change is decided from lineups that are NOT on the current map -- and the
   * check has to run against the map being switched to, before anything
   * changes level.
   */
  public async visibleOnMap(
    user: User,
    lineupIds: Array<string>,
    mapName: string,
  ): Promise<Set<string>> {
    if (lineupIds.length === 0) {
      return new Set();
    }

    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT l.id::text AS id
         FROM public.utility_lineups l
        WHERE l.id = ANY($1::uuid[])
          AND l.map_name = $2
          AND l.archived_at IS NULL
          AND public.can_view_utility_lineup(
                l,
                json_build_object(
                  'x-hasura-user-id', $3::text,
                  'x-hasura-role', $4::text
                )
              )`,
      [lineupIds, mapName, user.steam_id, user.role ?? "user"],
    );

    return new Set(rows.map((row) => row.id));
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

    if (at.switching) {
      return { sent: false, reason: "map_switching", map_name: at.map_name };
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

  /**
   * Stand the caller on a queue that is already in their library. This is what
   * a map change is left holding when the server turns out to be on the map
   * being asked for: there is no level to change, but the load the caller
   * asked for still has to be sent.
   */
  public async sendQueued(
    serverId: string,
    steamId: string,
    lineupIds: Array<string>,
  ): Promise<boolean> {
    const ids = lineupIds.filter(Boolean);

    if (ids.length === 0) {
      return false;
    }

    for (const id of ids) {
      UtilityLoadService.assertRconId(id);
    }

    const reply = await this.send(
      serverId,
      ids.length === 1
        ? `utility_practice_load ${steamId} ${ids[0]}`
        : `utility_practice_drill ${steamId} ${ids.join(",")}`,
    );

    if (reply === null) {
      return false;
    }

    this.logger.log(
      `[utility-load] ${steamId} -> ${ids.length} queued on ${serverId}`,
    );

    return true;
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

  /**
   * Change the level a practice server is running, and optionally hand it a
   * player to stand on a lineup once the new map is up.
   *
   * The plugin owns the queued half: it is the only thing that knows when the
   * player is actually back in the server, which is minutes after this returns
   * on a slow client. `queued` says whether it took that half -- a build that
   * predates `utility_practice_map` still gets the map change, from the same
   * changelevel/host_workshop_map branch MatchManager uses, but nobody lands
   * on anything.
   */
  public async changeMap(options: {
    serverId: string;
    mapName: string;
    workshopId: string | null;
    steamId?: string | null;
    lineupIds?: Array<string>;
  }): Promise<{ sent: boolean; queued: boolean }> {
    const target = options.workshopId ?? options.mapName;
    const ids = (options.lineupIds ?? []).filter(Boolean);

    for (const id of ids) {
      UtilityLoadService.assertRconId(id);
    }

    const queue =
      options.steamId && ids.length > 0
        ? ` ${options.steamId} ${ids.join(",")}`
        : "";

    const reply = await this.send(
      options.serverId,
      `utility_practice_map "${target}"${queue}`,
    );

    if (reply === null) {
      return { sent: false, queued: false };
    }

    if (!UtilityLoadService.isUnknownCommand(reply)) {
      this.logger.log(
        `[utility-load] ${options.serverId} -> map ${target}` +
          (queue ? ` (queued ${ids.length} for ${options.steamId})` : ""),
      );
      return { sent: true, queued: queue.length > 0 };
    }

    // Old plugin build. The map change is still worth doing on its own, so it
    // goes straight to the engine -- but nothing there can hold a load across
    // the level change, so the caller must not promise one.
    this.logger.warn(
      `[utility-load] ${options.serverId} does not know utility_practice_map; ` +
        `changing level directly`,
    );

    const fallback = await this.send(
      options.serverId,
      options.workshopId
        ? `host_workshop_map ${options.workshopId}`
        : `changelevel "${options.mapName}"`,
    );

    return { sent: fallback !== null, queued: false };
  }

  private static isUnknownCommand(reply: string): boolean {
    return reply.toLowerCase().includes("unknown command");
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

  public async remember(
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

    UtilityLoadService.assertRconId(id);

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
