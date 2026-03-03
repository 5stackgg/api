import { Controller, Logger } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { HasuraService } from "../hasura/hasura.service";
import { S3Service } from "../s3/s3.service";
import { User } from "../auth/types/User";

@Controller("tournaments")
export class TournamentsController {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly s3: S3Service,
  ) {}

  @HasuraAction()
  public async deleteTournament(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;
    this.logger.log(`[${tournament_id}] deleting tournament`);

    // Query with user context for authorization checks
    const { tournaments_by_pk } = await this.hasura.query(
      {
        tournaments_by_pk: {
          __args: {
            id: tournament_id,
          },
          id: true,
          status: true,
          is_organizer: true,
        },
      },
      data.user.steam_id,
    );

    if (!tournaments_by_pk) {
      throw Error("tournament not found");
    }

    if (!tournaments_by_pk.is_organizer) {
      throw Error("not the tournament organizer");
    }

    if (tournaments_by_pk.status === "Live") {
      throw Error("cannot delete a live tournament");
    }

    // Query as admin to access demo file paths
    const { tournaments_by_pk: tournament } = await this.hasura.query({
      tournaments_by_pk: {
        __args: {
          id: tournament_id,
        },
        stages: {
          brackets: {
            match: {
              id: true,
              match_maps: {
                demos: {
                  id: true,
                  file: true,
                },
              },
            },
          },
        },
      },
    });

    const demos: Array<{ id: string; file: string }> = [];
    const matchIds: string[] = [];

    for (const stage of tournament.stages || []) {
      for (const bracket of stage.brackets || []) {
        if (!bracket.match) {
          continue;
        }
        matchIds.push(bracket.match.id);
        for (const matchMap of bracket.match.match_maps || []) {
          for (const demo of matchMap.demos || []) {
            demos.push(demo);
          }
        }
      }
    }

    for (const demo of demos) {
      try {
        await this.s3.remove(demo.file);
        await this.hasura.mutation({
          delete_match_map_demos_by_pk: {
            __args: {
              id: demo.id,
            },
            __typename: true,
          },
        });
      } catch (error) {
        this.logger.error(
          `[${tournament_id}] failed to clean up demo ${demo.id}`,
          error,
        );
      }
    }

    for (const matchId of matchIds) {
      try {
        await this.hasura.mutation({
          delete_matches_by_pk: {
            __args: {
              id: matchId,
            },
            __typename: true,
          },
        });
      } catch (error) {
        this.logger.error(
          `[${tournament_id}] failed to delete match ${matchId}`,
          error,
        );
      }
    }

    await this.hasura.mutation({
      delete_tournaments_by_pk: {
        __args: {
          id: tournament_id,
        },
        __typename: true,
      },
    });

    this.logger.log(
      `[${tournament_id}] tournament deleted, cleaned up ${demos.length} demo files across ${matchIds.length} matches`,
    );

    return {
      success: true,
    };
  }
}
