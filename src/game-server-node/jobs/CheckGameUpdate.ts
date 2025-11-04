import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Logger } from "@nestjs/common";
import { GameServerNodeService } from "../game-server-node.service";
import { HasuraService } from "src/hasura/hasura.service";
import { NotificationsService } from "src/notifications/notifications.service";

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
  buildid: number;
  description: string;
  timeupdated: string;
};

type GameData = {
  depots: {
    branches: {
      [key: string]: Branch;
    };
  } & {
    [key: string]: Depot | unknown;
  };
};

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

      const buildId = branch.buildid;

      versions.push(buildId);

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
          version: true,
          description: true,
        },
      });

      if (game_versions.length > 0) {
        const foundVersion = game_versions.at(0);
        if (
          foundVersion.version !== version ||
          foundVersion.description !== branch.description
        ) {
          await this.hasuraService.mutation({
            update_game_versions_by_pk: {
              __args: {
                pk_columns: { build_id: buildId },
                _set: {
                  version,
                  description: branch.description || buildId.toString(),
                },
              },
              __typename: true,
            },
          });
        }
        continue;
      }

      await this.hasuraService.mutation({
        insert_game_versions_one: {
          __args: {
            object: {
              current: false,
              version,
              build_id: buildId,
              description: branch.description || buildId.toString(),
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

    await this.updateCurrentBuild(data.depots.branches["public"]);
  }

  private async updateCurrentBuild(publicBranch: Branch) {
    if (!publicBranch) {
      return;
    }

    const currentBuild = await this.gameServerNodeService.getCurrentBuild();

    if (currentBuild === publicBranch.buildid) {
      return;
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

    const { update_game_versions_by_pk } = await this.hasuraService.mutation({
      update_game_versions_by_pk: {
        __args: {
          pk_columns: {
            build_id: publicBranch.buildid,
          },
          _set: {
            current: true,
          },
        },
        version: true,
      },
    });

    this.notifications.send("GameUpdate", {
      message: `A CS2 Update (${update_game_versions_by_pk.version === "public" ? publicBranch.buildid.toString() : update_game_versions_by_pk.version}) has been detected. The Game Node Servers that do not have a build pin will update automatically.`,
      title: "CS2 Update",
      role: "administrator",
    });

    await this.gameServerNodeService.updateCs();
  }

  private async getGameData(): Promise<GameData> {
    const response = await fetch("https://api.steamcmd.net/v1/info/730");

    if (!response.ok) {
      this.logger.error("Failed to fetch CS2 update", {
        status: response.status,
        statusText: response.statusText,
      });
      return;
    }

    const { data } = await response.json();
    const gameData = data?.["730"] as GameData;

    for (const branch in gameData.depots.branches) {
      gameData.depots.branches[branch].buildid = parseInt(
        gameData.depots.branches[branch].buildid as unknown as string,
      );
    }

    return gameData;
  }
}
