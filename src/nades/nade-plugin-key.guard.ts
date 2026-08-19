import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Request } from "express";
import { PostgresService } from "../postgres/postgres.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

// Deliberately not the match-server middleware: that authenticates a server
// against a specific match id in the body, and the nade endpoints are keyed on
// the server's own identity instead. The server id still has to be proven, so a
// valid plugin key alone buys nothing without the matching api_password.
@Injectable()
export class NadePluginKeyGuard implements CanActivate {
  constructor(private readonly postgres: PostgresService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const presented = String(
      request.headers.authorization ?? request.headers.Authorization ?? "",
    )
      .replace(/^bearer\s+/i, "")
      .trim();

    if (!presented) {
      return false;
    }

    const [row] = await this.postgres.query<Array<{ value: string }>>(
      "SELECT value FROM public.settings WHERE name = $1 LIMIT 1",
      [SystemSettingName.NadePluginApiKey],
    );

    if (!row?.value) {
      return false;
    }

    if (!timingSafeStringEqual(row.value, presented)) {
      return false;
    }

    const serverId = String(
      (request.body as { server_id?: string })?.server_id ??
        request.query["server_id"] ??
        "",
    );

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        serverId,
      )
    ) {
      return false;
    }

    const [server] = await this.postgres.query<
      Array<{ api_password: string | null }>
    >("SELECT api_password FROM public.servers WHERE id = $1::uuid", [
      serverId,
    ]);

    if (!server) {
      return false;
    }

    const serverPassword = String(
      request.headers["x-server-api-password"] ?? "",
    );

    if (!timingSafeStringEqual(server.api_password ?? "", serverPassword)) {
      return false;
    }

    (request as Request & { nadeServerId?: string }).nadeServerId = serverId;

    return true;
  }
}
