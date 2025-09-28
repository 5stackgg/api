import { Controller } from "@nestjs/common";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { server_regions_set_input, servers_set_input } from "generated";
import { DedicatedServersService } from "./dedicated-servers.service";
import { HasuraService } from "src/hasura/hasura.service";

@Controller("dedicated-servers")
export class DedicatedServersController {
  constructor(
    private readonly hasura: HasuraService,
    private readonly dedicatedServersService: DedicatedServersService,
  ) {}

  @HasuraEvent()
  public async servers(data: HasuraEventData<servers_set_input>) {
    if (!data.old.is_dedicated || !data.new.is_dedicated) {
      return;
    }

    await this.dedicatedServersService.removeDedicatedServer(data.old.id);

    if (
      data.old.game_server_node_id !== data.new.game_server_node_id ||
      data.new.enabled === false
    ) {
      return;
    }

    await this.dedicatedServersService.setupDedicatedServer(data.new.id);
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
}
