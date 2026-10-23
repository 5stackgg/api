import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { DemoQueues } from "../enums/DemoQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { DemoMetadataService } from "../demo-metadata.service";

@UseQueue("Demos", DemoQueues.Demos)
export class CleanDemos extends WorkerHost {
  private maxStorageInBytes: number;
  private minRetentionInDays: number;
  private totalStoredBytes: number;

  constructor(
    private readonly demoMetadata: DemoMetadataService,
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const { settings } = await this.hasura.query({
      settings: {
        __args: {
          where: {
            _or: [
              {
                name: {
                  _eq: "s3_min_retention",
                },
              },
              {
                name: {
                  _eq: "s3_max_storage",
                },
              },
            ],
          },
        },
        name: true,
        value: true,
      },
    });

    this.minRetentionInDays = parseInt(
      settings.find(function (setting) {
        return setting.name === "s3_min_retention";
      })?.value || "1",
    );

    const maxStorageInGB = parseInt(
      settings.find(function (setting) {
        return setting.name === "s3_max_storage";
      })?.value || "10",
    );

    this.maxStorageInBytes = maxStorageInGB * 1024 * 1024 * 1024;

    const { match_map_demos_aggregate } = await this.hasura.query({
      match_map_demos_aggregate: {
        aggregate: {
          sum: {
            size: true,
            playback_size: true,
          },
        },
      },
    });

    this.totalStoredBytes =
      (match_map_demos_aggregate.aggregate.sum.size ?? 0) +
      (match_map_demos_aggregate.aggregate.sum.playback_size ?? 0);

    return await this.deleteOldDemos();
  }

  private async deleteOldDemos() {
    if (this.totalStoredBytes <= this.maxStorageInBytes) {
      return 0;
    }

    const finishedAfter = new Date(
      Date.now() - this.minRetentionInDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const attempted: Array<string> = [];
    let deleted = 0;
    let freedBytes = 0;

    while (this.totalStoredBytes > this.maxStorageInBytes) {
      const demos = await this.findOldestDemos(finishedAfter, attempted);

      if (demos.length === 0) {
        break;
      }

      for (const demo of demos) {
        if (this.totalStoredBytes <= this.maxStorageInBytes) {
          break;
        }

        attempted.push(demo.id);

        try {
          await this.demoMetadata.deleteDemo(demo.id);
        } catch (error) {
          this.logger.warn(
            `[clean-demos] failed to delete demo ${demo.id}: ${(error as Error)?.message}`,
          );
          continue;
        }

        const bytes = (demo.size ?? 0) + (demo.playback_size ?? 0);
        this.totalStoredBytes -= bytes;
        freedBytes += bytes;
        deleted++;
      }
    }

    if (deleted > 0) {
      this.logger.log(
        `Deleted ${deleted} demos, freeing up ${this.formatStorageSize(freedBytes)}`,
      );
    }

    return deleted;
  }

  private async findOldestDemos(
    finishedAfter: string,
    attempted: Array<string>,
  ) {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          limit: 10,
          where: {
            id: {
              _nin: attempted,
            },
            match: {
              ended_at: {
                _lt: finishedAfter,
              },
            },
          },
          order_by: [
            {
              match: {
                ended_at: "asc",
              },
            },
            {
              id: "asc",
            },
          ],
        },
        id: true,
        size: true,
        playback_size: true,
      },
    });

    return match_map_demos;
  }

  private formatStorageSize(bytes: number): string {
    const megabytes = bytes / (1024 * 1024);
    const gigabytes = megabytes / 1024;

    if (gigabytes >= 1) {
      return `${gigabytes.toFixed(2)} GB`;
    }
    return `${megabytes.toFixed(2)} MB`;
  }
}
