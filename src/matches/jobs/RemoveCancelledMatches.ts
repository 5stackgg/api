import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { DemoMetadataService } from "../../demos/demo-metadata.service";
import { ClipsService } from "../clips/clips.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class RemoveCancelledMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly clips: ClipsService,
  ) {
    super();
  }

  async process(): Promise<number> {
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
                _and: [
                  {
                    cancels_at: {
                      _is_null: false,
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
      },
    });

    for (const match of matches) {
      await this.clips.deleteClipsForMatch(match.id);
      await this.demoMetadata.deleteDemosForMatch(match.id);

      await this.hasura.mutation({
        delete_matches_by_pk: {
          __args: {
            id: match.id,
          },
          __typename: true,
        },
      });
    }

    if (matches.length > 0) {
      this.logger.log(`removed ${matches.length} canceled matches`);
    }

    return matches.length;
  }
}
