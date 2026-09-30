import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import { PostgresService } from "src/postgres/postgres.service";
import { RconService } from "src/rcon/rcon.service";
import { DedicatedServersService } from "src/dedicated-servers/dedicated-servers.service";
import { SanctionType, SERVER_ENFORCED_SANCTION_TYPES } from "./sanction-types";

@Injectable()
export class SanctionsService {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly rconService: RconService,
    private readonly dedicatedServersService: DedicatedServersService,
  ) {}

  private static readonly MAX_SYNC_STEAM_IDS = 256;

  private static readonly PLAYER_MANAGEMENT_RUNTIMES = [
    "swiftlys2",
    "counterstrikesharp",
  ];

  private static readonly SANCTION_TYPES: SanctionType[] = [
    "ban",
    "mute",
    "gag",
    "silence",
    "warning",
  ];

  public async syncServerSanctions(
    serverId: string,
    params: {
      steamIds?: unknown;
      pluginVersion?: unknown;
      pluginRuntime?: unknown;
    },
  ): Promise<
    Array<{
      steam_id: string;
      type: SanctionType;
      reason: string | null;
      expires_at: string | null;
    }>
  > {
    await this.recordPlayerManagement(
      serverId,
      params.pluginVersion,
      params.pluginRuntime,
    );

    // Anything past 18 digits can overflow the bigint cast and fail the whole
    // query; a real SteamID64 is 17.
    const steamIds = Array.isArray(params.steamIds)
      ? [
          ...new Set(
            params.steamIds
              .map((steamId) => String(steamId))
              .filter((steamId) => /^\d{1,18}$/.test(steamId)),
          ),
        ].slice(0, SanctionsService.MAX_SYNC_STEAM_IDS)
      : [];

    if (steamIds.length === 0) {
      return [];
    }

    const sanctions = await this.postgres.query<
      Array<{
        steam_id: string;
        type: SanctionType;
        reason: string | null;
        expires_at: Date | null;
      }>
    >(
      `SELECT player_steam_id::text AS steam_id,
              type,
              reason,
              remove_sanction_date AS expires_at
         FROM public.player_sanctions
        WHERE deleted_at IS NULL
          AND type = ANY($1::text[])
          AND player_steam_id = ANY($2::bigint[])
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())`,
      [SERVER_ENFORCED_SANCTION_TYPES, steamIds],
    );

    return sanctions.map((sanction) => ({
      steam_id: sanction.steam_id,
      type: sanction.type,
      reason: sanction.reason ?? null,
      expires_at: sanction.expires_at
        ? new Date(sanction.expires_at).toISOString()
        : null,
    }));
  }

  public async sanctionServerPlayer(params: {
    serverId?: string | null;
    steamId: string;
    type: SanctionType;
    reason?: string | null;
    duration?: number | null;
    sanctionedBySteamId: string;
  }): Promise<{ id: string | null; enforced: boolean; message: string }> {
    const { serverId, steamId, type, reason, duration, sanctionedBySteamId } =
      params;

    if (!SanctionsService.SANCTION_TYPES.includes(type)) {
      throw Error(`invalid sanction type ${type}`);
    }

    if (type === "warning") {
      return await this.warnPlayer(steamId, reason, sanctionedBySteamId);
    }

    let onServer:
      | { steam_id: string; name: string; userid: string | null }
      | undefined;

    if (serverId) {
      const roster =
        await this.dedicatedServersService.getServerPlayerList(serverId);
      onServer = roster.find((player) => player.steam_id === steamId);
    }

    await this.ensurePlayer(steamId, onServer?.name);

    let removeSanctionDate: string | null = null;
    if (duration && duration > 0) {
      removeSanctionDate = new Date(Date.now() + duration).toISOString();
    }

    const { insert_player_sanctions_one } = await this.hasura.mutation({
      insert_player_sanctions_one: {
        __args: {
          object: {
            type,
            player_steam_id: steamId,
            sanctioned_by_steam_id: sanctionedBySteamId,
            reason: reason ?? null,
            remove_sanction_date: removeSanctionDate,
          },
        },
        id: true,
      },
    });

    let enforced = false;
    let message = "sanction saved";

    if (serverId) {
      const result = await this.syncServer(
        serverId,
        type === "ban" ? (onServer?.userid ?? null) : null,
      );
      enforced = result.enforced;
      message = result.message;
    }

    return {
      id: insert_player_sanctions_one?.id ?? null,
      enforced,
      message,
    };
  }

  public async unsanctionServerPlayer(params: {
    serverId?: string | null;
    steamId: string;
    type: SanctionType;
    sanctionId?: string | null;
  }): Promise<{ id: string | null; enforced: boolean; message: string }> {
    const { serverId, steamId, type, sanctionId } = params;

    if (!SanctionsService.SANCTION_TYPES.includes(type)) {
      throw Error(`invalid sanction type ${type}`);
    }

    // Removal by type clears every active row of that type, which for warnings
    // would wipe the player's whole record to retract one of them.
    if (type === "warning" && !sanctionId) {
      throw Error("a warning is removed by its sanction id");
    }

    let removedId: string | null = null;

    if (sanctionId) {
      const removed = await this.postgres.query<Array<{ id: string }>>(
        `UPDATE public.player_sanctions
            SET deleted_at = now()
          WHERE id = $1::uuid
            AND player_steam_id = $2::bigint
            AND type = $3
            AND deleted_at IS NULL
          RETURNING id`,
        [sanctionId, steamId, type],
      );
      removedId = removed.at(0)?.id ?? null;

      if (!removedId) {
        throw Error("sanction not found");
      }
    } else {
      await this.postgres.query(
        `UPDATE public.player_sanctions
            SET deleted_at = now()
          WHERE player_steam_id = $1::bigint
            AND type = $2
            AND deleted_at IS NULL`,
        [steamId, type],
      );
    }

    let enforced = false;
    let message = type === "warning" ? "warning removed" : "sanction removed";

    if (serverId && SERVER_ENFORCED_SANCTION_TYPES.includes(type)) {
      const result = await this.syncServer(serverId, null);
      enforced = result.enforced;
      message = result.message;
    }

    return {
      id: removedId,
      enforced,
      message,
    };
  }

  public async kickServerPlayer(params: {
    serverId: string;
    steamId: string;
    reason?: string | null;
  }): Promise<{ kicked: boolean; message: string }> {
    const { serverId, steamId, reason } = params;

    const userid = await this.dedicatedServersService.resolveServerUserId(
      serverId,
      steamId,
    );

    if (!userid) {
      return { kicked: false, message: "player is not on the server" };
    }

    const message = (reason || "Kicked")
      .replace(/[\r\n";]/g, " ")
      .trim()
      .slice(0, 120);

    try {
      const rcon = await this.rconService.connect(serverId);
      if (!rcon) {
        return { kicked: false, message: "unable to connect to server rcon" };
      }

      await rcon.send(`kickid ${userid} ${message}`);

      return { kicked: true, message: "player kicked" };
    } catch (error) {
      this.logger.warn(`failed to kick ${steamId} on ${serverId}`, error);
      return { kicked: false, message: "failed to kick player" };
    } finally {
      await this.rconService.disconnect(serverId);
    }
  }

  private async warnPlayer(
    steamId: string,
    reason: string | null | undefined,
    sanctionedBySteamId: string,
  ): Promise<{ id: string | null; enforced: boolean; message: string }> {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw Error("a reason is required for a warning");
    }

    await this.ensurePlayer(steamId);

    const { insert_player_sanctions_one } = await this.hasura.mutation({
      insert_player_sanctions_one: {
        __args: {
          object: {
            type: "warning",
            player_steam_id: steamId,
            sanctioned_by_steam_id: sanctionedBySteamId,
            reason: trimmedReason,
            remove_sanction_date: null,
          },
        },
        id: true,
      },
    });

    return {
      id: insert_player_sanctions_one?.id ?? null,
      enforced: false,
      message: "warning saved",
    };
  }

  private async ensurePlayer(steamId: string, name?: string): Promise<void> {
    await this.hasura.mutation({
      insert_players: {
        __args: {
          objects: [
            {
              steam_id: steamId,
              name: name || `Player ${steamId}`,
            },
          ],
          on_conflict: {
            constraint: "players_pkey",
            update_columns: [],
          },
        },
        __typename: true,
      },
    });
  }

  // The plugin syncs every 30 seconds and this throttles the write to one a
  // minute, so the panel should treat a heartbeat older than a few minutes as
  // the plugin being gone.
  private async recordPlayerManagement(
    serverId: string,
    version: unknown,
    runtime: unknown,
  ): Promise<void> {
    let pluginVersion =
      typeof version === "string" && version.trim()
        ? version.trim().slice(0, 64)
        : null;

    if (pluginVersion === "__RELEASE_VERSION__") {
      pluginVersion = "dev";
    }

    const pluginRuntime =
      typeof runtime === "string" &&
      SanctionsService.PLAYER_MANAGEMENT_RUNTIMES.includes(runtime)
        ? runtime
        : null;

    try {
      await this.postgres.query(
        `UPDATE public.servers
            SET player_management_version = $2,
                player_management_runtime = $3,
                player_management_seen_at = now()
          WHERE id = $1::uuid
            AND (player_management_seen_at IS NULL
                 OR player_management_seen_at < now() - interval '60 seconds'
                 OR player_management_version IS DISTINCT FROM $2
                 OR player_management_runtime IS DISTINCT FROM $3)`,
        [serverId, pluginVersion, pluginRuntime],
      );
    } catch (error) {
      this.logger.warn(
        `unable to record the player management heartbeat for ${serverId}`,
        error,
      );
    }
  }

  private async syncTarget(
    serverId: string,
  ): Promise<"match" | "player-management" | null> {
    const { matches, servers_by_pk } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            server_id: {
              _eq: serverId,
            },
            status: {
              _nin: ["Canceled", "Finished", "Forfeit", "Surrendered", "Tie"],
            },
          },
          limit: 1,
        },
        id: true,
      },
      servers_by_pk: {
        __args: {
          id: serverId,
        },
        is_dedicated: true,
        type: true,
      },
    });

    if (matches.length > 0) {
      return "match";
    }

    if (
      servers_by_pk?.is_dedicated &&
      servers_by_pk.type !== "Ranked" &&
      servers_by_pk.type !== "Practice"
    ) {
      return "player-management";
    }

    return null;
  }

  private async syncServer(
    serverId: string,
    kickUserid: string | null,
  ): Promise<{ enforced: boolean; message: string }> {
    try {
      const rcon = await this.rconService.connect(serverId);
      if (!rcon) {
        return {
          enforced: false,
          message: "sanction saved; unable to connect to server rcon",
        };
      }

      if (kickUserid) {
        await rcon.send(`kickid ${kickUserid} Banned`);
      }

      const kicked = kickUserid !== null;
      const target = await this.syncTarget(serverId);

      // A match server's plugin carries mute/gag/ban as flags on the match
      // payload, so a match refresh is what actually re-applies them live.
      if (target === "match") {
        await rcon.send("get_match");

        return {
          enforced: true,
          message: "sanction saved and synced to server",
        };
      }

      if (target === "player-management") {
        // The plugin's reply is the contract here (PlayerManagementReport in
        // game-server): an unknown command means it is not loaded at all.
        const reply = await rcon.send("player_management_refresh");

        if (reply.includes("PlayerManagement: syncing")) {
          return {
            enforced: true,
            message: "sanction saved and synced to server",
          };
        }

        if (reply.includes("PlayerManagement:")) {
          return {
            enforced: kicked,
            message:
              "sanction saved; the Player Management plugin on this server is not configured",
          };
        }

        return {
          enforced: kicked,
          message: kicked
            ? "sanction saved and player kicked; the Player Management plugin is not installed on this server"
            : "sanction saved; the Player Management plugin is not installed on this server",
        };
      }

      return {
        enforced: kicked,
        message: kicked
          ? "sanction saved and player kicked; server has no match to sync"
          : "sanction saved; server has no match to sync",
      };
    } catch (error) {
      this.logger.warn(`failed to sync sanctions to ${serverId}`, error);
      return {
        enforced: false,
        message: "sanction saved; live enforcement failed",
      };
    } finally {
      await this.rconService.disconnect(serverId);
    }
  }
}
