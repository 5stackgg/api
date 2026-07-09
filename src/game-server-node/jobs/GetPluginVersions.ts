import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Logger } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import { PluginRuntime } from "src/configs/types/GameServersConfig";

type GithubRelease = {
  tag_name: string;
  body: string;
  published_at: string;
};

type PluginRelease = {
  version: string;
  min_game_build_id: number | null;
  published_at: string;
};

@UseQueue("GameServerNode", GameServerQueues.GameUpdate)
export class GetPluginVersions extends WorkerHost {
  private static readonly REPOSITORY = "5stackgg/game-server";

  // both plugins release out of one repo. CounterStrikeSharp's pre-monorepo tags are
  // bare v0.0.N and must keep matching, or the prune below strands nodes pinned to them.
  private static readonly RUNTIME_TAGS: Record<PluginRuntime, RegExp> = {
    swiftlys2: /^sw-v(\d+\.\d+\.\d+)$/,
    counterstrikesharp: /^(?:css-)?v(\d+\.\d+\.\d+)$/,
  };

  constructor(
    protected readonly logger: Logger,
    protected readonly hasuraService: HasuraService,
  ) {
    super();
  }

  async process(): Promise<void> {
    let releases: Array<GithubRelease>;

    try {
      releases = await this.fetchReleases(GetPluginVersions.REPOSITORY);
    } catch (error) {
      this.logger.warn(`unable to fetch plugin releases`, error.message);
      return;
    }

    for (const runtime of Object.keys(GetPluginVersions.RUNTIME_TAGS)) {
      try {
        await this.syncRuntime(runtime as PluginRuntime, releases);
      } catch (error) {
        this.logger.warn(
          `unable to sync plugin versions for ${runtime}`,
          error.message,
        );
      }
    }
  }

  private async syncRuntime(
    runtime: PluginRuntime,
    releases: Array<GithubRelease>,
  ) {
    const pluginReleases = this.releasesFor(runtime, releases);

    if (pluginReleases.length === 0) {
      // never prune on an empty read; a rate-limited response, or a tag scheme that
      // stopped matching, would wipe every version and null out the nodes pinned to them
      this.logger.warn(`no plugin releases matched for ${runtime}`);
      return;
    }

    for (const { version, min_game_build_id, published_at } of pluginReleases) {
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
              _nin: pluginReleases.map((release) => release.version),
            },
          },
        },
        __typename: true,
      },
    });
  }

  private releasesFor(
    runtime: PluginRuntime,
    releases: Array<GithubRelease>,
  ): Array<PluginRelease> {
    const pattern = GetPluginVersions.RUNTIME_TAGS[runtime];

    return releases.flatMap((release) => {
      const matched = pattern.exec(release.tag_name);

      if (!matched) {
        return [];
      }

      // The minimum game build is hand-written into the release notes.
      const buildId = Number.parseInt(release.body?.trim(), 10);

      return [
        {
          version: matched[1],
          min_game_build_id: Number.isNaN(buildId) ? null : buildId,
          published_at: release.published_at,
        },
      ];
    });
  }

  private async fetchReleases(
    repository: string,
  ): Promise<Array<GithubRelease>> {
    // two plugins share this feed; the default page of 30 could hide a runtime's
    // older releases and let the prune delete them
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100`,
    );

    if (!response.ok) {
      throw new Error(`${response.status} from ${repository} releases`);
    }

    const releases = await response.json();

    if (!Array.isArray(releases)) {
      throw new Error(`unexpected releases payload from ${repository}`);
    }

    return releases as Array<GithubRelease>;
  }
}
