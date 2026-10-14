import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Type,
  mixin,
} from "@nestjs/common";
import { Request } from "express";
import { e_player_roles_enum } from "generated";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { SystemSettingName } from "./enums/SystemSettingName";
import { SystemService } from "./system.service";

export function RoleSettingGuard(
  setting: SystemSettingName,
): Type<CanActivate> {
  @Injectable()
  class RoleSetting implements CanActivate {
    constructor(private readonly system: SystemService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const user = context.switchToHttp().getRequest<Request>().user;

      if (!user) {
        throw new ForbiddenException("Authentication required");
      }

      const role = (await this.system.getSetting(
        setting,
        "administrator",
      )) as e_player_roles_enum;

      if (!isRoleAbove(user.role, role)) {
        throw new ForbiddenException();
      }

      return true;
    }
  }

  return mixin(RoleSetting);
}
