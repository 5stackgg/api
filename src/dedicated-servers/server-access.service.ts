import { createHash } from "crypto";
import { Injectable } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";

export type ServerAllowlist = {
  restricted: boolean;
  version: string;
  steamIds: Array<string>;
};

export type ServerAccessSync = {
  restricted: boolean;
  version: string;
  denied: Array<string>;
  message: string | null;
};

@Injectable()
export class ServerAccessService {
  public static readonly OPEN_VERSION = "open";

  constructor(private readonly postgres: PostgresService) {}

  public async allowlist(serverId: string): Promise<ServerAllowlist> {
    const [server] = await this.postgres.query<
      Array<{ access_restricted: boolean }>
    >(`SELECT access_restricted FROM servers WHERE id = $1`, [serverId]);

    if (!server?.access_restricted) {
      return {
        restricted: false,
        version: ServerAccessService.OPEN_VERSION,
        steamIds: [],
      };
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM server_allowed_steam_ids($1)
        ORDER BY steam_id`,
      [serverId],
    );

    const steamIds = rows.map((row) => row.steam_id);

    return {
      restricted: true,
      version: ServerAccessService.version(steamIds),
      steamIds,
    };
  }

  // Recomputed on every sync rather than stamped on write: an event starting
  // or ending changes who is allowed without anything being saved.
  public async forSync(
    serverId: string,
    presentSteamIds: Array<string>,
  ): Promise<ServerAccessSync> {
    const access = await this.allowlist(serverId);

    if (!access.restricted) {
      return {
        restricted: false,
        version: access.version,
        denied: [],
        message: null,
      };
    }

    const allowed = new Set(access.steamIds);

    return {
      restricted: true,
      version: access.version,
      denied: presentSteamIds.filter((steamId) => !allowed.has(steamId)),
      message: null,
    };
  }

  public static version(steamIds: Array<string>): string {
    return createHash("sha256")
      .update(steamIds.join(","))
      .digest("hex")
      .slice(0, 16);
  }
}
