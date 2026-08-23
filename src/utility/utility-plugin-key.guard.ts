import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Request } from "express";
import { PostgresService } from "../postgres/postgres.service";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

// Deliberately not the match-server middleware: that authenticates a server
// against a specific match id in the body, and the utility endpoints are keyed on
// the server's own identity instead. Same proof either way -- the server's own
// api_password, which is what identifies it everywhere else.
@Injectable()
export class UtilityPluginKeyGuard implements CanActivate {
  constructor(private readonly postgres: PostgresService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

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

    (request as Request & { utilityServerId?: string }).utilityServerId = serverId;

    return true;
  }
}
