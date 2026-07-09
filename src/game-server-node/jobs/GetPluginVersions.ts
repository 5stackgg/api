import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Logger } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import { PluginRuntime } from "src/configs/types/GameServersConfig";

type PluginRelease = {
  version: string;
  min_game_build_id: number | null;
  published_at: string;
};

@UseQueue("GameServerNode", GameServerQueues.GameUpdate)
export class GetPluginVersions extends WorkerHost {
  private static readonly RUNTIME_REPOSITORIES: Record<PluginRuntime, string> =
    {
      swiftlys2: "5stackgg/swiftly-game-server",
      counterstrikesharp: "5stackgg/game-server",
    };

  constructor(
    protected readonly logger: Logger,
    protected readonly hasuraService: HasuraService,
  ) {
    super();
  }

  async process(): Promise<void> {
    for (const [runtime, repository] of Object.entries(
      GetPluginVersions.RUNTIME_REPOSITORIES,
    )) {
      try {
        await this.syncRuntime(runtime as PluginRuntime, repository);
      } catch (error) {
        this.logger.warn(
          `unable to sync plugin versions for ${runtime}`,
          error.message,
        );
      }
    }
  }

  private async syncRuntime(runtime: PluginRuntime, repository: string) {
    const releases = await this.fetchReleases(repository);

    if (releases.length === 0) {
      // Never prune on an empty read; a rate-limited GitHub response would wipe
      // every version for this runtime and null out the nodes pinned to them.
      this.logger.warn(`no plugin releases returned for ${repository}`);
      return;
    }

    for (const { version, min_game_build_id, published_at } of releases) {
      const { plugin_versions } = await this.hasuraService.query({
        plugin_versions: {
          __args: {
            where: {
              version: {
                _eq: version,
              },
              runtime: {
                _eq: runtime,
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
              runtime,
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
            runtime: {
              _eq: runtime,
            },
            version: {
              _nin: releases.map((release) => release.version),
            },
          },
        },
        __typename: true,
      },
    });
  }

  private async fetchReleases(
    repository: string,
  ): Promise<Array<PluginRelease>> {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases`,
    );

    if (!response.ok) {
      throw new Error(`${response.status} from ${repository} releases`);
    }

    const releases = await response.json();

    if (!Array.isArray(releases)) {
      throw new Error(`unexpected releases payload from ${repository}`);
    }

    return releases.map(
      (release: { tag_name: string; body: string; published_at: string }) => {
        // The minimum game build is hand-written into the release notes.
        const buildId = Number.parseInt(release.body?.trim(), 10);

        return {
          version: release.tag_name.replace("v", ""),
          min_game_build_id: Number.isNaN(buildId) ? null : buildId,
          published_at: release.published_at,
        };
      },
    );
  }
}
