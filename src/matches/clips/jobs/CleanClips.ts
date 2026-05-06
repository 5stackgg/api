import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../../enums/MatchQueues";
import { UseQueue } from "../../../utilities/QueueProcessors";
import { HasuraService } from "../../../hasura/hasura.service";
import { S3Service } from "../../../s3/s3.service";

const UNSIZED_BACKFILL_LIMIT = 25;
const DELETE_BATCH_SIZE = 10;

@UseQueue("Clips", MatchQueues.Clips)
export class CleanClips extends WorkerHost {
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

  async process(): Promise<number> {
    const { settings } = await this.hasura.query({
      settings: {
        __args: {
          where: {
            _or: [
              {
                name: {
                  _eq: "clips_min_retention",
                },
              },
              {
                name: {
                  _eq: "clips_max_storage",
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
        return setting.name === "clips_min_retention";
      })?.value || "1",
    );

    const maxStorageInGB = parseInt(
      settings.find(function (setting) {
        return setting.name === "clips_max_storage";
      })?.value || "10",
    );

    this.maxStorageInBytes = maxStorageInGB * 1024 * 1024 * 1024;

    const { match_clips_aggregate } = await this.hasura.query({
      match_clips_aggregate: {
        aggregate: {
          sum: {
            size: true,
          },
        },
      },
    });

    this.totalStoredBytes = match_clips_aggregate.aggregate.sum.size ?? 0;

    await this.backfillUnsizedClips();

    return await this.deleteOldClips();
  }

  private async backfillUnsizedClips(): Promise<void> {
    const { match_clips: unsized } = await this.hasura.query({
      match_clips: {
        __args: {
          limit: UNSIZED_BACKFILL_LIMIT,
          where: { size: { _eq: 0 } },
        },
        id: true,
        file: true,
        thumbnail_url: true,
      },
    });

    for (const row of unsized) {
      const videoSize = await this.safeStat(row.file);
      const thumbSize = row.thumbnail_url
        ? await this.safeStat(row.thumbnail_url)
        : 0;
      const total = videoSize + thumbSize;
      if (total === 0) {
        continue;
      }
      await this.hasura.mutation({
        update_match_clips_by_pk: {
          __args: {
            pk_columns: { id: row.id },
            _set: { size: total },
          },
          id: true,
        },
      });
      this.totalStoredBytes += total;
    }
  }

  private async safeStat(file: string | null | undefined): Promise<number> {
    if (!file) {
      return 0;
    }
    try {
      return (await this.s3.stat(file))?.size ?? 0;
    } catch (error) {
      if ((error as { code?: string })?.code === "NotFound") {
        return 0;
      }
      this.logger.warn(
        `[clean-clips] stat failed for ${file}: ${(error as Error)?.message}`,
      );
      return 0;
    }
  }

  private async deleteOldClips(): Promise<number> {
    if (this.totalStoredBytes < this.maxStorageInBytes) {
      return 0;
    }

    let totalDeleted = 0;
    let totalFreed = 0;

    while (this.totalStoredBytes >= this.maxStorageInBytes) {
      const batch = await this.findOldestEligibleClips();
      if (batch.length === 0) {
        break;
      }

      for (const clip of batch) {
        await this.s3.remove(clip.file);
        if (clip.thumbnail_url) {
          await this.s3.remove(clip.thumbnail_url);
        }
        await this.hasura.mutation({
          delete_match_clips_by_pk: {
            __args: { id: clip.id },
            __typename: true,
          },
        });

        this.totalStoredBytes -= clip.size;
        totalFreed += clip.size;
        totalDeleted++;

        if (this.totalStoredBytes < this.maxStorageInBytes) {
          break;
        }
      }
    }

    if (totalDeleted > 0) {
      this.logger.log(
        `Deleted ${totalDeleted} clips, freed ${this.formatStorageSize(totalFreed)}`,
      );
    }

    return totalDeleted;
  }

  private async findOldestEligibleClips(): Promise<
    Array<{
      id: string;
      size: number;
      file: string;
      thumbnail_url: string | null;
    }>
  > {
    const createdBefore = new Date(
      Date.now() - this.minRetentionInDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { match_clips } = await this.hasura.query({
      match_clips: {
        __args: {
          limit: DELETE_BATCH_SIZE,
          where: {
            created_at: {
              _lt: createdBefore,
            },
          },
          order_by: [
            {
              created_at: "asc",
            },
          ],
        },
        id: true,
        size: true,
        file: true,
        thumbnail_url: true,
      },
    });

    return match_clips;
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
