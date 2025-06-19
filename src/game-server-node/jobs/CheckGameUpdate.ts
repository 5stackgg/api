import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Logger } from "@nestjs/common";
import { GameServerNodeService } from "../game-server-node.service";
import { HasuraService } from "src/hasura/hasura.service";
import { NotificationsService } from "src/notifications/notifications.service";

@UseQueue("GameServerNode", GameServerQueues.GameUpdate)
export class CheckGameUpdate extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly gameServerNodeService: GameServerNodeService,
    protected readonly hasuraService: HasuraService,
    protected readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const response = await fetch("https://api.steamcmd.net/v1/info/730");

    const { data } = await response.json();

    const publicBuild = data["730"].depots?.branches?.public;

    if (!publicBuild) {
      return;
    }

    const {
      settings: [_currentVersion],
    } = await this.hasuraService.query({
      settings: {
        __args: {
          where: {
            name: {
              _eq: "cs_version",
            },
          },
        },
        value: true,
      },
    });

    const currentVersion = JSON.parse(_currentVersion.value);

    console.info({
      currentVersion,
      publicBuild,
    });

    if (currentVersion.buildid === publicBuild.buildid) {
      return;
    }

    await this.hasuraService.mutation({
      insert_settings_one: {
        __args: {
          object: {
            name: "cs_version",
            value: JSON.stringify(publicBuild),
          },
          on_conflict: {
            constraint: "settings_pkey",
            update_columns: ["value"],
          },
        },
        __typename: true,
      },
    });

    this.notifications.send("GameUpdate", {
      message: `A CS2 Update (${publicBuild.buildid}) has been detected. The Game Node Servers will update automatically.`,
      title: "CS2 Update",
      role: "administrator",
    });

    await this.gameServerNodeService.updateCs();
  }
}
