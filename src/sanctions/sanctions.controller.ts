import { Controller, Get, Param } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { User } from "src/auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { SanctionsService, SanctionType } from "./sanctions.service";

@Controller("sanctions")
export class SanctionsController {
  constructor(private readonly sanctionsService: SanctionsService) {}

  @Get("server/:serverId")
  public async serverSanctions(@Param("serverId") serverId: string) {
    return {
      sanctions: await this.sanctionsService.getActiveServerSanctions(serverId),
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
    user: User;
  }) {
    const { serverId, steam_id, type, user } = data;

    if (!user || !isRoleAbove(user.role, "moderator")) {
      throw Error("you are not allowed to remove sanctions");
    }

    return await this.sanctionsService.unsanctionServerPlayer({
      serverId,
      steamId: steam_id,
      type,
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
