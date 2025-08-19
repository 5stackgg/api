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

    if (!response.ok) {
      this.logger.error("Failed to fetch CS2 update", {
        status: response.status,
        statusText: response.statusText,
      });
      return;
    }

    const { data } = await response.json();

    const branches: {
      [key: string]: {
        buildid: string;
        description: string;
        timeupdated: string;
      };
    } = data["730"].depots?.branches;

    let versions = [];
    for (const version in branches) {
      const branch = branches[version];

      versions.push(branch.buildid);

      if (version === "public") {
        if (
          (await this.gameServerNodeService.getCurrentBuild()) ===
          branch.buildid
        ) {
          continue;
        }

        await this.hasuraService.mutation({
          update_game_versions: {
            __args: {
              where: {
                current: {
                  _eq: true,
                },
              },
              _set: {
                current: false,
              },
            },
            __typename: true,
          },
        });

        const { update_game_versions_by_pk } =
          await this.hasuraService.mutation({
            update_game_versions_by_pk: {
              __args: {
                pk_columns: {
                  build_id: branch.buildid,
                },
                _set: {
                  current: true,
                },
              },
              version: true,
            },
          });

        this.notifications.send("GameUpdate", {
          message: `A CS2 Update (${update_game_versions_by_pk.version}) has been detected. The Game Node Servers that do not have a build pin will update automatically.`,
          title: "CS2 Update",
          role: "administrator",
        });

        await this.gameServerNodeService.updateCs();
        continue;
      }

      const { game_versions } = await this.hasuraService.query({
        game_versions: {
          __args: {
            where: {
              build_id: {
                _eq: branch.buildid,
              },
            },
          },
          build_id: true,
        },
      });

      if (game_versions.length > 0) {
        continue;
      }

      await this.hasuraService.mutation({
        insert_game_versions_one: {
          __args: {
            object: {
              current: version === "public",
              version: version,
              build_id: branch.buildid,
              description: branch.description,
              updated_at: branch.timeupdated
                ? new Date(Number(branch.timeupdated) * 1000)
                : new Date(),
            },
            on_conflict: {
              constraint: "game_versions_pkey",
              update_columns: ["build_id", "version", "updated_at"],
            },
          },
          __typename: true,
        },
      });
    }

    if (versions.length === 0) {
      return;
    }

    await this.hasuraService.mutation({
      delete_game_versions: {
        __args: {
          where: {
            build_id: {
              _nin: versions,
            },
          },
        },
        __typename: true,
      },
    });
  }
}
