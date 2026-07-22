import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import { PostgresService } from "src/postgres/postgres.service";
import { RconService } from "src/rcon/rcon.service";
import { DedicatedServersService } from "src/dedicated-servers/dedicated-servers.service";

export type SanctionType = "ban" | "mute" | "gag" | "silence";

@Injectable()
export class SanctionsService {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly rconService: RconService,
    private readonly dedicatedServersService: DedicatedServersService,
  ) {}

  private static readonly SANCTION_TYPES: SanctionType[] = [
    "ban",
    "mute",
    "gag",
    "silence",
  ];

  public async getActiveServerSanctions(serverId: string): Promise<
    Array<{
      steam_id: string;
      is_banned: boolean;
      is_muted: boolean;
      is_gagged: boolean;
    }>
  > {
    const player_sanctions = await this.postgres.query<
      Array<{ player_steam_id: string; type: string }>
    >(
      `SELECT player_steam_id::text AS player_steam_id, type
         FROM public.player_sanctions
        WHERE deleted_at IS NULL
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())`,
    );

    const byPlayer: Record<
      string,
      { steam_id: string; is_banned: boolean; is_muted: boolean; is_gagged: boolean }
    > = {};

    for (const sanction of player_sanctions) {
      const steamId = `${sanction.player_steam_id}`;
      const entry = (byPlayer[steamId] = byPlayer[steamId] || {
        steam_id: steamId,
        is_banned: false,
        is_muted: false,
        is_gagged: false,
      });

      if (sanction.type === "ban") {
        entry.is_banned = true;
      } else if (sanction.type === "mute") {
        entry.is_muted = true;
      } else if (sanction.type === "gag") {
        entry.is_gagged = true;
      } else if (sanction.type === "silence") {
        entry.is_muted = true;
        entry.is_gagged = true;
      }
    }

    return Object.values(byPlayer);
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
  }): Promise<{ id: string | null; enforced: boolean; message: string }> {
    const { serverId, steamId, type } = params;

    if (!SanctionsService.SANCTION_TYPES.includes(type)) {
      throw Error(`invalid sanction type ${type}`);
    }

    await this.postgres.query(
      `UPDATE public.player_sanctions
          SET deleted_at = now()
        WHERE player_steam_id = $1::bigint
          AND type = $2
          AND deleted_at IS NULL`,
      [steamId, type],
    );

    let enforced = false;
    let message = "sanction removed";

    if (serverId) {
      const result = await this.syncServer(serverId, null);
      enforced = result.enforced;
      message = result.message;
    }

    return {
      id: null,
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

  private async hasLiveMatch(serverId: string): Promise<boolean> {
    const { matches } = await this.hasura.query({
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
    });

    return matches.length > 0;
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

      // The plugins carry mute/gag/ban as flags on the match payload, so a
      // match refresh is what actually re-applies them live. A server with no
      // match has no command to push sanctions to yet.
      if (!(await this.hasLiveMatch(serverId))) {
        return {
          enforced: kickUserid !== null,
          message: kickUserid
            ? "sanction saved and player kicked; server has no match to sync"
            : "sanction saved; server has no match to sync",
        };
      }

      await rcon.send("get_match");

      return {
        enforced: true,
        message: "sanction saved and synced to server",
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
