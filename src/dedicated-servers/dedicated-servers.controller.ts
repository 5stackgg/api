import { Controller } from "@nestjs/common";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { server_regions_set_input, servers_set_input } from "generated";
import { DedicatedServersService } from "./dedicated-servers.service";
import { HasuraService } from "src/hasura/hasura.service";
import { HasuraAction } from "src/hasura/hasura.controller";
import { game_server_nodes_set_input } from "generated/schema";
import { User } from "src/auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";

@Controller("dedicated-servers")
export class DedicatedServersController {
  constructor(
    private readonly hasura: HasuraService,
    private readonly dedicatedServersService: DedicatedServersService,
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

    await this.dedicatedServersService.removeDedicatedServer(serverId);

    if (
      data.op === "DELETE" ||
      !data.new.game_server_node_id ||
      data.new.enabled === false
    ) {
      return;
    }

    await this.dedicatedServersService.setupDedicatedServer(serverId);
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
      await this.dedicatedServersService.removeDedicatedServer(server.id);
      await this.dedicatedServersService.setupDedicatedServer(server.id);
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
        await this.dedicatedServersService.restartDedicatedServer(server.id);
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
}
