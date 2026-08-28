import { randomBytes } from "crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { PostgresService } from "../postgres/postgres.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { UtilityArtifactsService } from "./utility-artifacts.service";
import {
  MapCallout,
  UtilityCalloutsService,
} from "./utility-callouts.service";
import {
  UtilityIngestPayload,
  UtilityLineupForbidden,
  UtilityLineupsService,
  UtilityPracticeResultPayload,
  UtilityServerContext,
} from "./utility-lineups.service";
import { UtilityPluginKeyGuard } from "./utility-plugin-key.guard";
import { UtilityPracticeService } from "./utility-practice.service";

@Controller("utility")
export class UtilityController {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly lineups: UtilityLineupsService,
    private readonly artifacts: UtilityArtifactsService,
    private readonly practice: UtilityPracticeService,
    private readonly callouts: UtilityCalloutsService,
  ) {}

  @Post("ingest")
  @UseGuards(UtilityPluginKeyGuard)
  public async ingest(
    @Req() request: Request,
    @Body() body: UtilityIngestPayload,
  ) {
    await this.assertLibraryEnabled();

    // Measured before anything is parsed: a multi-megabyte path array is a
    // denial of service, not a lineup, and express has already accepted 50mb.
    const size = Buffer.byteLength(JSON.stringify(body ?? {}), "utf8");

    if (size > UtilityLineupsService.MAX_PAYLOAD_BYTES) {
      throw new BadRequestException("payload too large");
    }

    const context = await this.context(request);

    try {
      return await this.lineups.ingest(context, body);
    } catch (error) {
      throw new BadRequestException(
        (error as Error)?.message ?? "invalid lineup",
      );
    }
  }

  // The practice server's heartbeat. It is the only thing that can say who is
  // on it: no match plugin means no match-events socket to report connects on.
  @Post("occupancy")
  @UseGuards(UtilityPluginKeyGuard)
  public async occupancy(
    @Req() request: Request,
    @Body() body: { steam_ids?: Array<string>; steam_relay?: string | null },
  ) {
    await this.practice.reportOccupancy(
      UtilityController.serverId(request),
      Array.isArray(body?.steam_ids) ? body.steam_ids : [],
      typeof body?.steam_relay === "string" ? body.steam_relay : null,
    );

    return { ok: true };
  }

  // What the server found in the map it just loaded. Reported rather than
  // asked for, because only a server with the map open can answer, and a
  // workshop map is never going to be in the published extract.
  //
  // Deliberately does NOT resolve a server context: this fires on map load,
  // which is before a practice session exists, and the guard has already said
  // which server is talking.
  @Post("callouts")
  @UseGuards(UtilityPluginKeyGuard)
  public async reportCallouts(
    @Body() body: { map?: string; callouts?: Array<MapCallout> },
  ) {
    const map = String(body?.map ?? "").trim();

    if (!map) {
      throw new BadRequestException("no map");
    }

    return await this.callouts.report(
      map,
      Array.isArray(body?.callouts) ? body.callouts : [],
    );
  }

  @Get("library")
  @UseGuards(UtilityPluginKeyGuard)
  public async library(
    @Req() request: Request,
    @Query("steam_id") steamId: string,
  ) {
    await this.assertLibraryEnabled();

    const context = await this.context(request);

    try {
      return {
        map_name: context.mapName,
        lineups: await this.lineups.library(context, String(steamId ?? "")),
      };
    } catch (error) {
      throw new BadRequestException(
        (error as Error)?.message ?? "invalid request",
      );
    }
  }

  // How a practice server learns who is allowed to connect: with no match
  // plugin on the pod, the InitConnect gate lives in the practice plugin
  // instead, and this is where it gets its roster and password.
  //
  // The session is resolved from the authenticated server and never from a
  // parameter. A server that could name a session id could read a session it
  // is not running -- and the match password is what gets you onto that
  // server.
  @Get("session")
  @UseGuards(UtilityPluginKeyGuard)
  public async session(
    @Req() request: Request,
    @Query("map") reportedMap?: string,
  ) {
    const serverId = UtilityController.serverId(request);

    const session = await this.practice.sessionForServer(serverId);

    if (!session) {
      throw new NotFoundException(
        "this server is not running a practice session",
      );
    }

    // The plugin asking at all is the definitive signal that the server is up.
    await this.practice.markReady(session.match_id);

    // This fetch runs inside the plugin's map-load handler, so the map it names
    // is the one the level actually came up on -- the only thing that can end a
    // map change without guessing at how long a changelevel takes.
    await this.practice.markMapLoaded(
      session.session_id,
      reportedMap ? String(reportedMap) : null,
    );

    return session;
  }

  // Scores one throw. The session is resolved from the authenticated server
  // for the same reason GET /utility/session is: a server may only speak for the
  // session it is running. A session_id in the body is accepted so the plugin
  // can prove which session it thinks it is in, and rejected when it disagrees
  // -- it is never what the lookup keys on.
  @Post("practice-result")
  @UseGuards(UtilityPluginKeyGuard)
  public async practiceResult(
    @Req() request: Request,
    @Body() body: UtilityPracticeResultPayload,
  ) {
    await this.assertLibraryEnabled();

    const serverId = UtilityController.serverId(request);
    const session = await this.practice.liveSessionForServer(serverId);

    if (!session) {
      throw new NotFoundException(
        "this server is not running a practice session",
      );
    }

    if (body?.session_id && String(body.session_id) !== session.session_id) {
      throw new ForbiddenException("that is not this server's session");
    }

    const context = await this.context(request);

    try {
      return await this.lineups.recordPracticeResult(context, body);
    } catch (error) {
      throw new BadRequestException(
        (error as Error)?.message ?? "invalid result",
      );
    }
  }

  // Guarded by the server's own key like every other route here, not by a user
  // JWT: the practice plugin is the only caller and it authenticates as a
  // server. The steam id says who on that server is asking, which is what the
  // visibility check needs -- without it every lookup ran as a guest and no
  // private lineup ever resolved.
  @Get(":lineupId/trajectory")
  @UseGuards(UtilityPluginKeyGuard)
  public async trajectory(
    @Req() request: Request,
    @Param("lineupId") lineupId: string,
    @Query("steam_id") steamId: string,
  ): Promise<StreamableFile> {
    await this.assertLibraryEnabled();

    const context = await this.context(request);

    let file: string | null;

    try {
      file = await this.lineups.trajectoryFile(
        context,
        String(steamId ?? ""),
        lineupId,
      );
    } catch (error) {
      throw new ForbiddenException(
        (error as Error)?.message ?? "invalid request",
      );
    }

    if (!file || !(await this.artifacts.hasTrajectory(file))) {
      throw new NotFoundException("trajectory missing");
    }

    return new StreamableFile(await this.artifacts.readTrajectory(file));
  }

  /**
   * Change a lineup that already exists.
   *
   * Nothing else could: the only UPDATE on the table sets name, description and
   * visibility from the panel's own action, and the plugin had ingest and
   * delete and nothing between them. Fixing a throw therefore meant deleting it
   * and recording it again, which loses the id and every scored attempt hanging
   * off it.
   */
  @Patch(":id")
  @UseGuards(UtilityPluginKeyGuard)
  public async update(
    @Req() request: Request,
    @Param("id") id: string,
    @Body()
    body: {
      steam_id?: string;
      name?: string;
      description?: string;
      visibility?: string;
      geometry?: Record<string, number>;
    },
  ) {
    await this.assertLibraryEnabled();

    const context = await this.context(request);
    const author = String(body?.steam_id ?? "");

    // Same gate the delete beside this uses: the server key says which server
    // is asking, and the roster says the player it names is actually on it.
    if (!context.lineupSteamIds.includes(author)) {
      throw new ForbiddenException("player is not in this match lineup");
    }

    try {
      return await this.lineups.updateLineup({
        lineupId: id,
        steamId: author,
        name: body?.name ?? null,
        description: body?.description ?? null,
        visibility: body?.visibility ?? null,
        geometry: UtilityController.geometry(body?.geometry),
      });
    } catch (error) {
      if (error instanceof UtilityLineupForbidden) {
        throw new ForbiddenException({
          message: error.message,
          reason: error.reason,
        });
      }

      throw new BadRequestException(
        (error as Error)?.message ?? "invalid request",
      );
    }
  }

  /**
   * Geometry is taken whole or not at all. A lineup carries where you stand,
   * where you look and where it lands as one description of one throw, and a
   * partial write leaves a row describing a throw nobody ever made.
   */
  private static geometry(input?: Record<string, number>) {
    if (!input) {
      return null;
    }

    const columns = UtilityLineupsService.GEOMETRY_COLUMNS;

    const present = columns.filter((column) =>
      Number.isFinite(Number(input[column])),
    );

    if (present.length === 0) {
      return null;
    }

    if (present.length !== columns.length) {
      throw new BadRequestException("the geometry is incomplete");
    }

    return Object.fromEntries(
      columns.map((column) => [column, Number(input[column])]),
    ) as Record<(typeof columns)[number], number>;
  }

  @Delete(":id")
  @UseGuards(UtilityPluginKeyGuard)
  public async remove(
    @Req() request: Request,
    @Param("id") id: string,
    @Query("steam_id") steamId: string,
  ) {
    const context = await this.context(request);
    const author = String(steamId ?? "");

    if (!context.lineupSteamIds.includes(author)) {
      throw new ForbiddenException("player is not in this match lineup");
    }

    try {
      await this.lineups.deleteLineup(id, author);
    } catch (error) {
      throw new BadRequestException(
        (error as Error)?.message ?? "unable to delete",
      );
    }

    return { success: true };
  }

  // Set by UtilityPluginKeyGuard once it has matched the server's api_password.
  private static serverId(request: Request): string {
    return String(
      (request as Request & { utilityServerId?: string }).utilityServerId,
    );
  }

  private async context(request: Request): Promise<UtilityServerContext> {
    const context = await this.lineups.serverContext(
      UtilityController.serverId(request),
    );

    if (!context) {
      throw new BadRequestException("this server has no live match");
    }

    return context;
  }

  private async assertLibraryEnabled(): Promise<void> {
    if (!(await this.lineups.isLibraryEnabled())) {
      throw new ForbiddenException("the utility library is disabled");
    }
  }
}
