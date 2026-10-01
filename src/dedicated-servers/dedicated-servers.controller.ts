import { Controller, ForbiddenException, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { server_regions_set_input, servers_set_input } from "generated";
import { DedicatedServersService } from "./dedicated-servers.service";
import { DedicatedServerConfigService } from "./dedicated-server-config.service";
import { HasuraService } from "src/hasura/hasura.service";
import { HasuraAction } from "src/hasura/hasura.controller";
import { game_server_nodes_set_input } from "generated/schema";
import { User } from "src/auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { DedicatedServerMigrationService } from "./dedicated-server-migration.service";
import { DedicatedServerQueues } from "./enums/DedicatedServerQueues";
import { CleanupDedicatedServerFiles } from "./jobs/CleanupDedicatedServerFiles";

@Controller("dedicated-servers")
export class DedicatedServersController {
  constructor(
    private readonly hasura: HasuraService,
    private readonly dedicatedServersService: DedicatedServersService,
    private readonly dedicatedServerConfig: DedicatedServerConfigService,
    private readonly migrations: DedicatedServerMigrationService,
    private readonly logger: Logger,
    @InjectQueue(DedicatedServerQueues.ServerMaintenance)
    private readonly maintenanceQueue: Queue,
  ) {}

  @HasuraEvent()
  public async servers(data: HasuraEventData<servers_set_input>) {
    const serverId = data.old.id || data.new.id;
    // this cannot be flipped
    const isDedicated = data.old.is_dedicated || data.new.is_dedicated;

    if (
      !isDedicated ||
      (!data.old.game_server_node_id && !data.new.game_server_node_id)
    ) {
      return;
    }

    await this.dedicatedServersService.rebuildDedicatedServer(
      serverId,
      data.op !== "DELETE" &&
        !!data.new.game_server_node_id &&
        data.new.enabled !== false,
    );

    if (data.op === "DELETE" && data.old.game_server_node_id) {
      await this.maintenanceQueue.add(
        CleanupDedicatedServerFiles.name,
        { serverId, gameServerNodeId: data.old.game_server_node_id },
        {
          jobId: `cleanup-server-files:${serverId}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 60 * 1000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
  }

  @HasuraEvent()
  public async dedicated_server_region_relay(
    data: HasuraEventData<server_regions_set_input>,
  ) {
    const { servers } = await this.hasura.query({
      servers: {
        __args: {
          where: {
            region: {
              _eq: data.new.value,
            },
            is_dedicated: {
              _eq: true,
            },
            enabled: {
              _eq: true,
            },
            game_server_node_id: {
              _is_null: false,
            },
          },
        },
        id: true,
      },
    });

    for (const server of servers) {
      await this.dedicatedServersService.rebuildDedicatedServer(server.id);
    }
  }

  @HasuraEvent()
  public async game_server_cs_build_changed(
    data: HasuraEventData<game_server_nodes_set_input>,
  ) {
    if (data.new.build_id && data.old.build_id !== data.new.build_id) {
      const { servers } = await this.hasura.query({
        servers: {
          __args: {
            where: {
              game_server_node_id: {
                _eq: data.new.id,
              },
              enabled: {
                _eq: true,
              },
              is_dedicated: {
                _eq: true,
              },
            },
          },
          id: true,
        },
      });
      for (const server of servers) {
        try {
          await this.dedicatedServersService.restartDedicatedServer(server.id);
        } catch (error) {
          this.logger.warn(
            `[${server.id}] unable to restart after the CS2 build changed: ${error?.message ?? error}`,
          );
        }
      }
    }
  }

  @HasuraAction()
  public async getDedicatedServerInfo() {
    return await this.dedicatedServersService.getAllDedicatedServerStats();
  }

  @HasuraAction()
  public async getDedicatedServerPlayers(data: {
    serverId: string;
    user: User;
  }) {
    const { serverId, user } = data;

    if (!user || !isRoleAbove(user.role, "moderator")) {
      throw Error("you are not allowed to view server players");
    }

    const players =
      await this.dedicatedServersService.getServerPlayerList(serverId);

    if (players.length > 0) {
      await this.hasura.mutation({
        insert_players: {
          __args: {
            objects: players.map((player) => ({
              steam_id: player.steam_id,
              name: player.name || `Player ${player.steam_id}`,
            })),
            on_conflict: {
              constraint: "players_pkey",
              update_columns: [],
            },
          },
          __typename: true,
        },
      });
    }

    return players.map((player) => ({
      steam_id: player.steam_id,
      name: player.name,
    }));
  }

  @HasuraAction()
  public async setServerMapRotation(data: {
    user: User;
    server_id: string;
    map_ids: Array<string>;
    shuffle: boolean;
  }) {
    this.assertAdministrator(data.user);

    await this.dedicatedServerConfig.setMapRotation(
      data.server_id,
      data.map_ids,
      data.shuffle,
    );

    return { success: true };
  }

  @HasuraAction()
  public async setServerPlugins(data: {
    user: User;
    server_id: string;
    plugins: Array<{ slug: string; enabled: boolean }>;
  }) {
    this.assertAdministrator(data.user);

    await this.dedicatedServerConfig.setPlugins(data.server_id, data.plugins);

    return { success: true };
  }

  @HasuraAction()
  public async importWorkshopCollection(data: {
    user: User;
    collection: string;
  }) {
    this.assertAdministrator(data.user);

    return await this.dedicatedServerConfig.importWorkshopCollection(
      data.collection,
    );
  }

  @HasuraAction()
  public async moveDedicatedServerToNode(data: {
    user: User;
    server_id: string;
    game_server_node_id: string;
    without_files?: boolean;
  }) {
    this.assertAdministrator(data.user);

    await this.migrations.requestMove(
      data.user,
      data.server_id,
      data.game_server_node_id,
      !!data.without_files,
    );

    return { success: true };
  }

  @HasuraAction()
  public async cancelDedicatedServerMove(data: {
    user: User;
    server_id: string;
  }) {
    this.assertAdministrator(data.user);

    await this.migrations.requestCancel(data.server_id);

    return { success: true };
  }

  private assertAdministrator(user: User): void {
    if (!user || !isRoleAbove(user.role, "administrator")) {
      throw new ForbiddenException("Administrator access required");
    }
  }
}
