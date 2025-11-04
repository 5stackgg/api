import { Controller } from "@nestjs/common";
import { SystemService } from "./system.service";
import { HasuraAction } from "src/hasura/hasura.controller";
import { Get } from "@nestjs/common";
import { User } from "src/auth/types/User";
import { HasuraService } from "src/hasura/hasura.service";
import { NotificationsService } from "src/notifications/notifications.service";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { settings_set_input } from "generated/schema";
import { GameServerNodeService } from "src/game-server-node/game-server-node.service";

@Controller("system")
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly hasura: HasuraService,
    private readonly notifications: NotificationsService,
    private readonly gameServerNodeService: GameServerNodeService,
  ) {}

  @Get("healthz")
  public async status() {
    return;
  }

  @HasuraAction()
  public async updateServices() {
    await this.system.updateServices();

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async restartService(data: { service: string }) {
    await this.system.restartService(data.service);

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async registerName(data: { user: User; name: string }) {
    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: {
            steam_id: data.user.steam_id,
          },
          _set: {
            name: data.name,
            name_registered: true,
          },
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async approveNameChange(data: { name: string; steam_id: string }) {
    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: {
            steam_id: data.steam_id,
          },
          _set: {
            name: data.name,
            name_registered: true,
          },
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async requestNameChange(data: { name: string; steam_id: string }) {
    const { notifications } = await this.hasura.query({
      notifications: {
        __args: {
          where: {
            type: {
              _eq: "NameChangeRequest",
            },
            entity_id: {
              _eq: data.steam_id,
            },
            is_read: {
              _eq: false,
            },
          },
        },
        __typename: true,
      },
    });

    if (notifications.length > 0) {
      throw new Error("You have already requested a name change");
    }

    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: data.steam_id,
        },
        name: true,
      },
    });

    if (!player) {
      throw new Error("Player not found");
    }

    await this.notifications.send(
      "NameChangeRequest",
      {
        message: `Player ${player.name} has requested to change their name to ${data.name}`,
        title: "Name Change Request",
        role: "administrator",
        entity_id: data.steam_id,
      },
      [
        {
          label: "Approve",
          graphql: {
            type: "mutation",
            action: "approveNameChange",
            variables: {
              name: data.name,
              steam_id: data.steam_id,
            },
            selection: {
              success: true,
            },
          },
        },
      ],
    );

    return {
      success: true,
    };
  }

  @HasuraEvent()
  public async settings(data: HasuraEventData<settings_set_input>) {
    if (
      (data.new.name === "demo_network_limiter" ||
        data.old.name === "demo_network_limiter") &&
      (data.op === "INSERT" ||
        data.op === "DELETE" ||
        data.new.value !== data.old.value)
    ) {
      await this.gameServerNodeService.updateDemoNetworkLimiters();
    }
  }
}
