import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Logger } from "@nestjs/common";
import { GameServerNodeService } from "../game-server-node.service";
import { HasuraService } from "src/hasura/hasura.service";
import { NotificationsService } from "src/notifications/notifications.service";
import { CacheService } from "src/cache/cache.service";

type Depot = {
  systemdefined?: string;
  config: {
    osarch?: string;
    oslist?: string;
    optionaldlc?: string;
  };
  manifests: {
    [key: string]: {
      gid: string;
    };
  };
};

type Branch = {
  buildid: string;
  description: string;
  timeupdated: string;
};

@UseQueue("GameServerNode", GameServerQueues.GameUpdate)
export class CheckGameUpdate extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly gameServerNodeService: GameServerNodeService,
    protected readonly hasuraService: HasuraService,
    protected readonly notifications: NotificationsService,
    protected readonly cache: CacheService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const data = await this.getGameData();

    if (!data) {
      this.logger.error("No depots found for CS2", {
        data,
      });
      return;
    }

    const depots: Map<string, Depot> = new Map();
    for (const depotId in data.depots) {
      const depot = data.depots[depotId] as Depot;
      if (!depotId.match(/^[0-9]+$/)) {
        continue;
      }

      const depotConfig = depot.config;

      if (
        (depot.systemdefined && !depotConfig) ||
        (depotConfig &&
          !depotConfig.optionaldlc &&
          depotConfig.osarch === "64" &&
          (!depotConfig.oslist || depotConfig.oslist.includes("linux")))
      ) {
        depots.set(depotId, depot);
      }
    }

    let versions = [];
    for (const version in data.depots.branches) {
      const branch = data.depots.branches[version];

      const buildId = parseInt(branch.buildid);

      versions.push(buildId);

      if (version === "public") {
        if ((await this.gameServerNodeService.getCurrentBuild()) === buildId) {
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
                  build_id: buildId,
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

      let downloadable = true;
      const downloads: Array<{
        gid: string;
        depotId: string;
      }> = [];
      for (const depotId of depots.keys()) {
        const gid = depots.get(depotId).manifests[version]?.gid;
        if (!gid) {
          downloadable = false;
          break;
        }
        downloads.push({
          gid,
          depotId,
        });
      }

      if (!downloadable) {
        // this is when a version is not meant for a server
        continue;
      }

      const { game_versions } = await this.hasuraService.query({
        game_versions: {
          __args: {
            where: {
              build_id: {
                _eq: buildId,
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
              version,
              build_id: buildId,
              description: branch.description,
              downloads,
              updated_at: branch.timeupdated
                ? new Date(Number(branch.timeupdated) * 1000)
                : new Date(),
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

  private async getGameData(): Promise<{
    depots: {
      branches: {
        [key: string]: Branch;
      };
    } & {
      [key: string]: Depot | unknown;
    };
  }> {
    return this.cache.remember(
      "game-data",
      async () => {
        const response = await fetch("https://api.steamcmd.net/v1/info/730");

        if (!response.ok) {
          this.logger.error("Failed to fetch CS2 update", {
            status: response.status,
            statusText: response.statusText,
          });
          return;
        }

        const { data } = await response.json();

        return data?.["730"];
      },
      5 * 60,
    );
  }
}
