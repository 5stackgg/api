import { Controller, Logger } from "@nestjs/common";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { DemoMetadataService } from "../demos/demo-metadata.service";
import { ClipsService } from "../matches/clips/clips.service";
import { User } from "../auth/types/User";
import { DiscordTournamentVoiceService } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.service";
import { tournaments_set_input } from "../../generated";

@Controller("tournaments")
export class TournamentsController {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly clips: ClipsService,
    private readonly tournamentVoice: DiscordTournamentVoiceService,
  ) {}

  @HasuraEvent()
  public async tournament_events(data: HasuraEventData<tournaments_set_input>) {
    const tournamentId = (data.new.id || data.old.id) as string;
    const status = data.new.status as string;

    if (status === "Live" && data.old.status !== "Live") {
      await this.tournamentVoice.createTournamentReadyRoom(tournamentId);
    }

    if (["Finished", "Cancelled", "CancelledMinTeams"].includes(status)) {
      await this.tournamentVoice.removeTournamentVoice(tournamentId);
    }

    // Cancelling resets the bracket: drop the matches (and their demos) so
    // they can be regenerated. tournament_brackets.match_id is ON DELETE
    // SET NULL, so the brackets themselves stay in place.
    if (status === "Cancelled" && data.old.status !== "Cancelled") {
      const { matchCount } = await this.deleteTournamentMatches(tournamentId);
      this.logger.log(
        `[${tournamentId}] tournament cancelled, cleaned up assets across ${matchCount} matches`,
      );
    }
  }

  @HasuraAction()
  public async deleteTournament(data: { user: User; tournament_id: string }) {
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

    const {
      league_season_divisions_aggregate,
      league_relegation_playoffs_aggregate,
    } = await this.hasura.query({
      league_season_divisions_aggregate: {
        __args: { where: { tournament_id: { _eq: tournament_id } } },
        aggregate: { count: true },
      },
      league_relegation_playoffs_aggregate: {
        __args: { where: { tournament_id: { _eq: tournament_id } } },
        aggregate: { count: true },
      },
    });

    if (
      league_season_divisions_aggregate.aggregate.count > 0 ||
      league_relegation_playoffs_aggregate.aggregate.count > 0
    ) {
      throw Error(
        "cannot delete a tournament that belongs to a league; manage it from the league instead",
      );
    }

    const { matchCount } = await this.deleteTournamentMatches(tournament_id);

    await this.hasura.mutation({
      delete_tournaments_by_pk: {
        __args: {
          id: tournament_id,
        },
        __typename: true,
      },
    });

    this.logger.log(
      `[${tournament_id}] tournament deleted, cleaned up assets across ${matchCount} matches`,
    );

    return {
      success: true,
    };
  }

  private async deleteTournamentMatches(
    tournament_id: string,
  ): Promise<{ matchCount: number }> {
    const { tournaments_by_pk: tournament } = await this.hasura.query({
      tournaments_by_pk: {
        __args: {
          id: tournament_id,
        },
        stages: {
          brackets: {
            match: {
              id: true,
            },
          },
        },
      },
    });

    const matchIds: string[] = [];
    for (const stage of tournament?.stages || []) {
      for (const bracket of stage.brackets || []) {
        if (bracket.match) {
          matchIds.push(bracket.match.id);
        }
      }
    }

    for (const matchId of matchIds) {
      try {
        // Purge S3 assets (demos + playback blobs, clip videos + thumbnails)
        // before deleting the match, which cascades the DB rows.
        await this.clips.deleteClipsForMatch(matchId);
        await this.demoMetadata.deleteDemosForMatch(matchId);
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

    return { matchCount: matchIds.length };
  }
}
