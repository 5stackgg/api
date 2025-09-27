import { Controller } from "@nestjs/common";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { servers_set_input } from "generated";
import { DedicatedServersService } from "./dedicated-servers.service";

@Controller("dedicated-servers")
export class DedicatedServersController {
  constructor(
    private readonly dedicatedServersService: DedicatedServersService,
  ) {}

  @HasuraEvent()
  public async servers(data: HasuraEventData<servers_set_input>) {
    if (!data.old.is_dedicated || !data.new.is_dedicated) {
      return;
    }

    if (
      data.old.game_server_node_id !== data.new.game_server_node_id ||
      data.new.enabled === false
    ) {
      await this.dedicatedServersService.removeDedicatedServer(data.old.id);
      return;
    }

    await this.dedicatedServersService.setupDedicatedServer(data.new.id);
  }
}
