import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { UtilityPluginKeyGuard } from "./utility-plugin-key.guard";
import {
  UtilityDiscoveryInput,
  UtilityDiscoveryOutcome,
  UtilityDiscoveryService,
} from "./utility-discovery.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("utility/discovery")
export class UtilityDiscoveryController {
  constructor(private readonly discoveries: UtilityDiscoveryService) {}

  @HasuraAction()
  public async discoverUtilityLineups(
    data: UtilityDiscoveryInput & { user: User },
  ) {
    return await this.discoveries.start(data.user, data);
  }

  @HasuraAction()
  public async cancelUtilityDiscovery(data: {
    user: User;
    discovery_id: string;
  }) {
    return {
      success: await this.discoveries.cancel(data.user, data.discovery_id),
    };
  }

  @HasuraAction()
  public async saveUtilityDiscoveryResult(data: {
    user: User;
    result_id: string;
    name: string;
    side: string;
  }) {
    return {
      lineup_id: await this.discoveries.save(
        data.user,
        data.result_id,
        data.name,
        data.side,
      ),
    };
  }

  @HasuraAction()
  public async previewUtilitySmoke(data: {
    user: User;
    map_name: string;
    x: number;
    y: number;
    z: number;
  }) {
    const preview = await this.discoveries.smoke(
      data.user.steam_id,
      data.map_name,
      {
        x: data.x,
        y: data.y,
        z: data.z,
      },
    );

    if (!preview) {
      return null;
    }

    const volume = preview.volume;

    return {
      ...preview.at,
      ox: volume?.ox ?? null,
      oy: volume?.oy ?? null,
      oz: volume?.oz ?? null,
      vs: volume?.vs ?? null,
      dx: volume?.dx ?? null,
      dy: volume?.dy ?? null,
      dz: volume?.dz ?? null,
      den: volume?.den ?? null,
    };
  }

  @Get(":id/job")
  @UseGuards(UtilityPluginKeyGuard)
  public async job(@Req() request: Request, @Param("id") id: string) {
    const job = await this.discoveries.job(
      UtilityDiscoveryController.id(id),
      UtilityDiscoveryController.serverId(request),
    );

    if (!job) {
      throw new NotFoundException("no such discovery for this server");
    }

    return job;
  }

  @Post(":id/results")
  @UseGuards(UtilityPluginKeyGuard)
  public async results(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { outcomes?: Array<UtilityDiscoveryOutcome> },
  ) {
    return {
      applied: await this.discoveries.report(
        UtilityDiscoveryController.id(id),
        UtilityDiscoveryController.serverId(request),
        Array.isArray(body?.outcomes) ? body.outcomes : [],
      ),
    };
  }

  @Post(":id/done")
  @UseGuards(UtilityPluginKeyGuard)
  public async done(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: { error?: string | null },
  ) {
    return {
      ok: await this.discoveries.done(
        UtilityDiscoveryController.id(id),
        UtilityDiscoveryController.serverId(request),
        typeof body?.error === "string" ? body.error : null,
      ),
    };
  }

  private static id(id: string): string {
    if (!UUID.test(id)) {
      throw new BadRequestException("not a discovery id");
    }
    return id;
  }

  private static serverId(request: Request): string {
    return String(
      (request as Request & { utilityServerId?: string }).utilityServerId,
    );
  }
}
