import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { S3Service } from "../../s3/s3.service";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class RemoveCancelledMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly s3Service: S3Service,
  ) {
    super();
  }

  async process(job: Job): Promise<number> {
    const yesterday = new Date();

    yesterday.setDate(yesterday.getDate() - 1);

    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            _and: [
              {
                is_tournament_match: {
                  _eq: false,
                },
              },
              {
                status: {
                  _in: ["PickingPlayers", "Canceled"],
                },
              },
              {
                _or: [
                  {
                    scheduled_at: {
                      _is_null: true,
                    },
                  },
                  {
                    cancels_at: {
                      _lte: yesterday,
                    },
                  },
                ],
              },
            ],
          },
        },
        id: true,
        match_maps: {
          demos: {
            id: true,
            file: true,
          },
          rounds: {
            id: true,
            backup_file: true,
          },
        },
      },
    });

    for (const match of matches) {
      for (const matchMap of match.match_maps) {
        for (const demo of matchMap.demos) {
          await this.s3Service.remove(demo.file);
          await this.hasura.mutation({
            delete_match_map_demos_by_pk: {
              __args: {
                id: demo.id,
              },
              __typename: true,
            },
          });
        }

        for (const round of matchMap.rounds) {
          await this.s3Service.remove(round.backup_file);
          await this.hasura.mutation({
            update_match_map_rounds_by_pk: {
              __args: {
                pk_columns: {
                  id: round.id,
                },
                __set: {
                  backup_file: null,
                },
              },
              __typename: true,
            },
          });
        }
      }
      await this.hasura.mutation({
        delete_matches_by_pk: {
          __args: {
            id: match.id,
          },
          __typename: true,
        },
      });
    }

    this.logger.log(`removed  ${matches.length} canceled matches`);

    return matches.length;
  }
}
