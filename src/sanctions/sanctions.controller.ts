import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { User } from "src/auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { SanctionsService } from "./sanctions.service";
import { SanctionType } from "./sanction-types";

@Controller("sanctions")
export class SanctionsController {
  constructor(private readonly sanctionsService: SanctionsService) {}

  // Polled by the game-server Player Management plugin; the call doubles as
  // its heartbeat.
  @Post("server/:serverId")
  @HttpCode(200)
  public async syncServerSanctions(
    @Param("serverId") serverId: string,
    @Body()
    body: {
      steam_ids?: unknown;
      plugin_version?: unknown;
      plugin_runtime?: unknown;
    },
  ) {
    return {
      sanctions: await this.sanctionsService.syncServerSanctions(serverId, {
        steamIds: body?.steam_ids,
        pluginVersion: body?.plugin_version,
        pluginRuntime: body?.plugin_runtime,
      }),
    };
  }

  @HasuraAction()
  public async sanctionServerPlayer(data: {
    serverId?: string | null;
    steam_id: string;
    type: SanctionType;
    reason?: string | null;
    duration?: number | null;
    user: User;
  }) {
    const { serverId, steam_id, type, reason, duration, user } = data;

    if (!user || !isRoleAbove(user.role, "moderator")) {
      throw Error("you are not allowed to sanction players");
    }

    return await this.sanctionsService.sanctionServerPlayer({
      serverId,
      steamId: steam_id,
      type,
      reason,
      duration,
      sanctionedBySteamId: user.steam_id,
    });
  }

  @HasuraAction()
  public async unsanctionServerPlayer(data: {
    serverId?: string | null;
    steam_id: string;
    type: SanctionType;
    sanction_id?: string | null;
    user: User;
  }) {
    const { serverId, steam_id, type, sanction_id, user } = data;

    if (!user || !isRoleAbove(user.role, "moderator")) {
      throw Error("you are not allowed to remove sanctions");
    }

    return await this.sanctionsService.unsanctionServerPlayer({
      serverId,
      steamId: steam_id,
      type,
      sanctionId: sanction_id,
    });
  }

  @HasuraAction()
  public async kickServerPlayer(data: {
    serverId: string;
    steam_id: string;
    reason?: string | null;
    user: User;
  }) {
    const { serverId, steam_id, reason, user } = data;

    if (!user || !isRoleAbove(user.role, "moderator")) {
      throw Error("you are not allowed to kick players");
    }

    return await this.sanctionsService.kickServerPlayer({
      serverId,
      steamId: steam_id,
      reason,
    });
  }
}
