import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { DemoQueues } from "../enums/DemoQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { S3Service } from "../../s3/s3.service";

@UseQueue("Demos", DemoQueues.CleanDemos)
export class CleanDemos extends WorkerHost {
  private maxStorageInBytes: number;
  private minRetentionInDays: number;
  private totalStoredBytes: number;

  constructor(
    private readonly s3: S3Service,
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(job: Job): Promise<number> {
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
          },
        },
      },
    });

    this.totalStoredBytes = match_map_demos_aggregate.aggregate.sum.size;

    return await this.deleteOldDemos();
  }

  private async deleteOldDemos() {
    if (this.totalStoredBytes < this.maxStorageInBytes) {
      return 0;
    }

    const demosToDelete = await this.findDemosToDelete();

    if (demosToDelete.length > 0) {
      this.logger.log(
        `Marked ${demosToDelete.length} demos for deletion, freeing up ${this.formatStorageSize(demosToDelete.reduce((total, demo) => total + demo.size, 0))}`,
      );
      for (const demo of demosToDelete) {
        await this.s3.remove(demo.file);
        await this.hasura.mutation({
          delete_match_map_demos_by_pk: {
            __args: { id: demo.id },
            __typename: true,
          },
        });
        break;
      }
    }

    return demosToDelete.length;
  }

  private async findDemosToDelete(): Promise<
    Array<{
      id: string;
      size: number;
      file: string;
    }>
  > {
    const finishedAfter = new Date(
      Date.now() - this.minRetentionInDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          limit: 10,
          where: {
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
          ],
        },
        id: true,
        size: true,
        file: true,
      },
    });

    const demosToDelete = [];

    for (const demo of match_map_demos) {
      demosToDelete.push(demo);
      this.totalStoredBytes -= demo.size;

      if (this.totalStoredBytes > this.maxStorageInBytes) {
        break;
      }
    }

    if (this.totalStoredBytes > this.maxStorageInBytes) {
      const moreDemosToDelete = await this.findDemosToDelete();
      demosToDelete.push(...moreDemosToDelete);
    }

    return demosToDelete;
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
