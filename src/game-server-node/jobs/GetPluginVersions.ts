import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Logger } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";

@UseQueue("GameServerNode", GameServerQueues.GameUpdate)
export class GetPluginVersions extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly hasuraService: HasuraService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const response = await fetch(
      "https://api.github.com/repos/5stackgg/game-server/releases",
    );

    const releases = (await response.json()).map(
      (release: { tag_name: string; body: string; published_at: string }) => {
        const gameVersion = release.body?.trim();

        return {
          version: release.tag_name.replace("v", ""),
          min_game_build_id: gameVersion.length > 0 ? gameVersion : null,
          published_at: release.published_at,
        };
      },
    );

    for (const { version, min_game_build_id, published_at } of releases) {
      const { plugin_versions } = await this.hasuraService.query({
        plugin_versions: {
          __args: {
            where: {
              version: {
                _eq: version,
              },
            },
          },
          version: true,
          min_game_build_id: true,
        },
      });

      if (
        plugin_versions.length > 0 &&
        plugin_versions.at(0)?.min_game_build_id === min_game_build_id
      ) {
        continue;
      }

      await this.hasuraService.mutation({
        insert_plugin_versions_one: {
          __args: {
            object: {
              version,
              min_game_build_id,
              published_at,
            },
            on_conflict: {
              constraint: "plugin_versions_pkey",
              update_columns: ["min_game_build_id"],
            },
          },
          __typename: true,
        },
      });
    }

    await this.hasuraService.mutation({
      delete_plugin_versions: {
        __args: {
          where: {
            version: {
              _nin: releases.map(
                (release: { version: string }) => release.version,
              ),
            },
          },
        },
        __typename: true,
      },
    });
  }
}
