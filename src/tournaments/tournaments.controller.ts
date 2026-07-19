import { Controller, Logger } from "@nestjs/common";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { DemoMetadataService } from "../demos/demo-metadata.service";
import { ClipsService } from "../matches/clips/clips.service";
import { User } from "../auth/types/User";
import { DiscordTournamentVoiceService } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.service";
import { tournaments_set_input } from "../../generated";

// These tables are newer than the generated GraphQL types; event payloads are
// typed locally (mirrors the leagues controller).
type TournamentOrganizerTeamRow = {
  tournament_id?: string;
  team_id?: string;
};

type TeamRosterRow = {
  team_id?: string;
  player_steam_id?: string;
  role?: string;
};

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

  // Fired when an organisation team is linked to / unlinked from a tournament.
  // Linking expands every accepted member of the team into tournament_organizers;
  // unlinking removes the organizers that link contributed.
  @HasuraEvent()
  public async tournament_organizer_team_events(
    data: HasuraEventData<TournamentOrganizerTeamRow>,
  ) {
    const tournamentId = (data.new?.tournament_id ||
      data.old?.tournament_id) as string;
    const teamId = (data.new?.team_id || data.old?.team_id) as string;

    if (!tournamentId || !teamId) {
      return;
    }

    if (data.op === "DELETE") {
      await this.removeOrganizationTeamOrganizers(tournamentId, teamId);
      await this.syncRemainingOrganizationTeams(tournamentId);
      return;
    }

    await this.syncOrganizationTeamOrganizers(tournamentId, teamId);
  }

  // A tournament_organizers row carries a single organization_team_id, so someone
  // on two linked org teams is only ever tagged with the first. Unlinking that team
  // drops them even though the other team still entitles them, so re-sync whatever
  // links remain to put them back.
  private async syncRemainingOrganizationTeams(tournamentId: string) {
    const { tournament_organizer_teams } = await this.hasura.query({
      tournament_organizer_teams: {
        __args: {
          where: { tournament_id: { _eq: tournamentId } },
        },
        team_id: true,
      },
    });

    for (const link of tournament_organizer_teams) {
      await this.syncOrganizationTeamOrganizers(tournamentId, link.team_id);
    }
  }

  // Fired when a team's roster changes. Re-syncs organizers for every tournament
  // that uses this team as an organisation team so additions/removals propagate.
  @HasuraEvent()
  public async tournament_org_roster_events(
    data: HasuraEventData<TeamRosterRow>,
  ) {
    const teamId = (data.new?.team_id || data.old?.team_id) as string;

    if (!teamId) {
      return;
    }

    const { tournament_organizer_teams } = await this.hasura.query({
      tournament_organizer_teams: {
        __args: {
          where: { team_id: { _eq: teamId } },
        },
        tournament_id: true,
      },
    });

    // Sync the changed team first (it performs the removals), then the
    // tournament's other links: a removed member tagged with this team may
    // still be entitled by another linked team, which must re-add them.
    for (const link of tournament_organizer_teams) {
      await this.syncOrganizationTeamOrganizers(link.tournament_id, teamId);
      await this.syncRemainingOrganizationTeams(link.tournament_id);
    }
  }

  // Every roster member of an organisation team. A team_roster row is already an
  // accepted member -- pending invites live in team_invites, and e_team_roles
  // ("Member" / "Invite" / "Admin") describes roster powers, not invite state, so
  // filtering on role here would silently drop real members.
  private async getOrganizationTeamSteamIds(teamId: string): Promise<string[]> {
    const { team_roster } = await this.hasura.query({
      team_roster: {
        __args: {
          where: {
            team_id: { _eq: teamId },
          },
        },
        player_steam_id: true,
      },
    });

    return team_roster.map((member) => String(member.player_steam_id));
  }

  private async syncOrganizationTeamOrganizers(
    tournamentId: string,
    teamId: string,
  ) {
    const steamIds = await this.getOrganizationTeamSteamIds(teamId);

    const { tournament_organizers: existing } = await this.hasura.query({
      tournament_organizers: {
        __args: {
          where: { tournament_id: { _eq: tournamentId } },
        },
        steam_id: true,
      },
    });

    const existingSteamIds = new Set(
      existing.map((organizer) => String(organizer.steam_id)),
    );
    const toInsert = steamIds.filter(
      (steamId) => !existingSteamIds.has(steamId),
    );

    if (toInsert.length > 0) {
      // on_conflict: concurrent events for the same tournament race between the
      // read above and this insert; the PK hit must not fail the whole batch.
      await this.hasura.mutation({
        insert_tournament_organizers: {
          __args: {
            objects: toInsert.map((steam_id) => ({
              steam_id,
              tournament_id: tournamentId,
              organization_team_id: teamId,
            })),
            on_conflict: {
              constraint: "tournament_organizers_pkey",
              update_columns: [],
            },
          },
          affected_rows: true,
        },
      });
    }

    // Drop organizers this team previously contributed who are no longer on its
    // roster. Manually-added organizers (organization_team_id IS NULL) are left
    // untouched.
    await this.hasura.mutation({
      delete_tournament_organizers: {
        __args: {
          where: {
            tournament_id: { _eq: tournamentId },
            organization_team_id: { _eq: teamId },
            ...(steamIds.length > 0 ? { steam_id: { _nin: steamIds } } : {}),
          },
        },
        affected_rows: true,
      },
    });
  }

  private async removeOrganizationTeamOrganizers(
    tournamentId: string,
    teamId: string,
  ) {
    await this.hasura.mutation({
      delete_tournament_organizers: {
        __args: {
          where: {
            tournament_id: { _eq: tournamentId },
            organization_team_id: { _eq: teamId },
          },
        },
        affected_rows: true,
      },
    });
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
