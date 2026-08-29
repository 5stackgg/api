import { Controller, Logger } from "@nestjs/common";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { DemoMetadataService } from "../demos/demo-metadata.service";
import { ClipsService } from "../matches/clips/clips.service";
import { User } from "../auth/types/User";
import { DiscordTournamentVoiceService } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.service";
import { tournaments_set_input } from "../../generated";
import { NotificationsService } from "../notifications/notifications.service";
import { PostgresService } from "../postgres/postgres.service";

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

// The registration / check-in columns are newer than generated/schema.ts, so
// every read of them goes through raw SQL rather than the typed Hasura client.
type TournamentAccess = {
  id: string;
  name: string;
  status: string;
  start: string;
  banner: string | null;
  logo: string | null;
  organizer_steam_id: string | null;
  registration_type: string;
  invite_only: boolean;
  check_in_required: boolean;
  check_in_setting: string;
  check_in_open: boolean;
  is_organizer: boolean;
  unlocked: boolean;
};

type CheckInTeam = {
  id: string;
  can_manage: boolean;
  is_captain: boolean;
};

@Controller("tournaments")
export class TournamentsController {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly clips: ClipsService,
    private readonly tournamentVoice: DiscordTournamentVoiceService,
    private readonly notifications: NotificationsService,
    private readonly postgres: PostgresService,
  ) {}

  private async announceRegistrationOpen(
    tournamentId: string,
    tournament: tournaments_set_input,
  ) {
    try {
      const name = NotificationsService.escapeHtml(
        (tournament.name as string) ?? "A tournament",
      );

      const image = (tournament.banner ?? tournament.logo) as
        | string
        | null
        | undefined;

      await this.notifications.notifyActivePlayers("TournamentCreated", {
        title: "New tournament",
        message: `<a href="/tournaments/${tournamentId}"><b>${name}</b></a> is open for signups.`,
        entity_id: tournamentId,
        data: { image },
      });
    } catch (error) {
      this.logger.warn(
        `[${tournamentId}] unable to announce open registration`,
        error,
      );
    }
  }

  @HasuraEvent()
  public async tournament_events(data: HasuraEventData<tournaments_set_input>) {
    const tournamentId = (data.new.id || data.old.id) as string;
    const status = data.new.status as string;

    // "Created", from a player's point of view, is when signups open. Firing
    // on the table INSERT instead would announce tournaments an organizer is
    // still halfway through configuring.
    if (
      status === "RegistrationOpen" &&
      data.old.status !== "RegistrationOpen"
    ) {
      await this.announceRegistrationOpen(tournamentId, data.new);
    }

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

  // Every guard below runs here rather than in a trigger or a permission
  // filter. The writes land on the API's pooled connection, which carries no
  // hasura.user, and every existing SQL guard treats a role-less session as an
  // internal write -- so an action that skipped its own check would be
  // unguarded, not merely redundant.
  private hasuraSession(user: User): string {
    return JSON.stringify({
      "x-hasura-role": user.role,
      "x-hasura-user-id": user.steam_id,
    });
  }

  private async getTournamentAccess(
    tournamentId: string,
    user: User,
  ): Promise<TournamentAccess> {
    const [tournament] = await this.postgres.query<Array<TournamentAccess>>(
      `SELECT t.id::text AS id,
              t.name,
              t.status,
              t."start",
              t.banner,
              t.logo,
              t.organizer_steam_id::text AS organizer_steam_id,
              t.registration_type,
              t.invite_only,
              t.check_in_required,
              t.check_in_setting,
              COALESCE(tournament_check_in_open(t), false) AS check_in_open,
              COALESCE(is_tournament_organizer(t, $2::json), false) AS is_organizer,
              tournament_registration_unlocked(t.id, $3::bigint) AS unlocked
         FROM tournaments t
        WHERE t.id = $1::uuid`,
      [tournamentId, this.hasuraSession(user), user.steam_id],
    );

    if (!tournament) {
      throw Error("tournament not found");
    }

    return tournament;
  }

  private requireOrganizer(tournament: TournamentAccess) {
    if (!tournament.is_organizer) {
      throw Error("not the tournament organizer");
    }
  }

  // The bracket is drawn and matches may already be in play; re-admitting or
  // re-drafting into it is a different, much riskier feature.
  private static readonly BRACKET_IN_PLAY = [
    "Live",
    "Paused",
    "Finished",
    "Cancelled",
    "CancelledMinTeams",
  ];

  @HasuraAction()
  public async checkIntoTournament(data: {
    user: User;
    tournament_id: string;
    tournament_team_id?: string;
  }) {
    const { tournament_id, tournament_team_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    if (!tournament.check_in_required) {
      throw Error("this tournament does not require check-in");
    }

    if (!tournament.check_in_open) {
      throw Error("the check-in window is not open");
    }

    const team = await this.resolveCheckInTeam(
      tournament_id,
      tournament_team_id,
      data.user,
    );

    // An undrafted free agent has no team to confirm for; their own row is the
    // whole confirmation, whatever check_in_setting says. Checked only after
    // the team lookup, so a free agent who has since been drafted (or joined a
    // team in a 'both' tournament) still confirms through that team.
    if (!team) {
      const freeAgent = await this.postgres.query<Array<{ id: string }>>(
        `UPDATE tournament_free_agents
            SET checked_in_at = now()
          WHERE tournament_id = $1::uuid
            AND player_steam_id = $2::bigint
            AND status <> 'withdrawn'
        RETURNING id::text AS id`,
        [tournament_id, data.user.steam_id],
      );

      if (freeAgent.length === 0) {
        throw Error("you are not registered for this tournament");
      }

      return { success: true };
    }

    switch (tournament.check_in_setting) {
      case "Admin": {
        this.requireOrganizer(tournament);
        break;
      }
      case "Players": {
        const confirmed = await this.postgres.query<Array<{ id: string }>>(
          `UPDATE tournament_team_roster
              SET checked_in_at = now()
            WHERE tournament_team_id = $1::uuid
              AND player_steam_id = $2::bigint
          RETURNING tournament_team_id::text AS id`,
          [team.id, data.user.steam_id],
        );

        if (confirmed.length === 0) {
          throw Error("you are not on this team's roster");
        }

        // taiu_tournament_team_roster_check_in rolls the per-player stamps up
        // into the team once the minimum lineup has confirmed.
        return { success: true };
      }
      default: {
        if (!team.can_manage && !team.is_captain) {
          throw Error("only the team captain can check this team in");
        }
        break;
      }
    }

    await this.postgres.query(
      `UPDATE tournament_teams
          SET checked_in_at = now()
        WHERE id = $1::uuid
          AND tournament_id = $2::uuid
          AND checked_in_at IS NULL`,
      [team.id, tournament_id],
    );

    return { success: true };
  }

  private async resolveCheckInTeam(
    tournamentId: string,
    tournamentTeamId: string | undefined,
    user: User,
  ): Promise<CheckInTeam | undefined> {
    const session = this.hasuraSession(user);

    if (tournamentTeamId) {
      const [team] = await this.postgres.query<Array<CheckInTeam>>(
        `SELECT tt.id::text AS id,
                COALESCE(can_manage_tournament_team(tt, $3::json), false) AS can_manage,
                tt.captain_steam_id = $4::bigint OR tt.owner_steam_id = $4::bigint AS is_captain
           FROM tournament_teams tt
          WHERE tt.id = $1::uuid AND tt.tournament_id = $2::uuid`,
        [tournamentTeamId, tournamentId, session, user.steam_id],
      );

      if (!team) {
        throw Error("team is not registered for this tournament");
      }

      return team;
    }

    const [team] = await this.postgres.query<Array<CheckInTeam>>(
      `SELECT DISTINCT tt.id::text AS id,
              COALESCE(can_manage_tournament_team(tt, $2::json), false) AS can_manage,
              tt.captain_steam_id = $3::bigint OR tt.owner_steam_id = $3::bigint AS is_captain
         FROM tournament_teams tt
         LEFT JOIN tournament_team_roster ttr
                ON ttr.tournament_team_id = tt.id
               AND ttr.player_steam_id = $3::bigint
        WHERE tt.tournament_id = $1::uuid
          AND (
              ttr.player_steam_id IS NOT NULL
              OR tt.owner_steam_id = $3::bigint
              OR tt.captain_steam_id = $3::bigint
          )
        LIMIT 1`,
      [tournamentId, session, user.steam_id],
    );

    return team;
  }

  @HasuraAction()
  public async readmitTournamentTeam(data: {
    user: User;
    tournament_id: string;
    tournament_team_id: string;
  }) {
    const { tournament_id, tournament_team_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (TournamentsController.BRACKET_IN_PLAY.includes(tournament.status)) {
      throw Error("cannot re-admit a team once the tournament is live");
    }

    const readmitted = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE tournament_teams
          SET checked_in_at = now()
        WHERE id = $1::uuid AND tournament_id = $2::uuid
      RETURNING id::text AS id`,
      [tournament_team_id, tournament_id],
    );

    if (readmitted.length === 0) {
      throw Error("team is not registered for this tournament");
    }

    // assign_seeds_to_teams recomputes eligibility from scratch every run, so
    // the stamp above only takes effect once it has run again.
    await this.postgres.query(
      `SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1::uuid`,
      [tournament_id],
    );

    this.logger.log(
      `[${tournament_id}] re-admitted team ${tournament_team_id} after a missed check-in`,
    );

    return { success: true };
  }

  @HasuraAction()
  public async extendTournamentCheckIn(data: {
    user: User;
    tournament_id: string;
    minutes: number;
  }) {
    const { tournament_id, minutes } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (tournament.status !== "CheckInReview") {
      throw Error("the tournament is not held for check-in review");
    }

    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
      throw Error("extend the check-in window by 1 to 240 minutes");
    }

    // Measured from now, not from the deadline that already passed: a review is
    // only reached after the cutoff, so extending "by 10 minutes" from a stale
    // deadline could still land in the past.
    const extended = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE tournaments t
          SET check_in_ends_at = GREATEST(t.check_in_ends_at, now()) + make_interval(mins => $2::int),
              status = 'RegistrationOpen'
        WHERE t.id = $1::uuid
          AND t.status = 'CheckInReview'
          AND GREATEST(t.check_in_ends_at, now()) + make_interval(mins => $2::int) < t."start"
      RETURNING t.id::text AS id`,
      [tournament_id, minutes],
    );

    if (extended.length === 0) {
      throw Error(
        "the extended check-in window would end after the tournament starts",
      );
    }

    const recipients = await this.pendingCheckInRecipients(tournament_id);

    if (recipients.length > 0) {
      await this.notifications.notifyPlayers("TournamentCheckInOpen", {
        title: "Tournament check-in re-opened",
        message: `<a href="/tournaments/${tournament_id}"><b>${NotificationsService.escapeHtml(
          tournament.name,
        )}</b></a> check-in has been extended by ${minutes} minutes. Confirm your spot.`,
        role: "user",
        entity_id: tournament_id,
        steamIds: recipients,
        data: { image: tournament.banner ?? tournament.logo },
      });
    }

    return { success: true };
  }

  // Deliberately narrower than the job's own recipient query: an extension is
  // only ever announced to the teams that held the tournament up.
  private async pendingCheckInRecipients(
    tournamentId: string,
  ): Promise<Array<string>> {
    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT steam_id::text AS steam_id FROM (
              SELECT ttr.player_steam_id AS steam_id
                FROM tournament_team_roster ttr
                JOIN tournament_teams tt ON tt.id = ttr.tournament_team_id
               WHERE tt.tournament_id = $1::uuid
                 AND tt.checked_in_at IS NULL
              UNION
              SELECT tt.owner_steam_id AS steam_id
                FROM tournament_teams tt
               WHERE tt.tournament_id = $1::uuid
                 AND tt.checked_in_at IS NULL
                 AND tt.owner_steam_id IS NOT NULL
            ) pending`,
      [tournamentId],
    );

    return rows.map((row) => row.steam_id);
  }

  @HasuraAction()
  public async continueTournamentCheckIn(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (tournament.status !== "CheckInReview") {
      throw Error("the tournament is not held for check-in review");
    }

    const continued = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE tournaments
          SET status = 'RegistrationClosed'
        WHERE id = $1::uuid AND status = 'CheckInReview'
      RETURNING id::text AS id`,
      [tournament_id],
    );

    if (continued.length === 0) {
      throw Error("the tournament is no longer held for check-in review");
    }

    this.logger.log(
      `[${tournament_id}] continued out of check-in review without the missing teams`,
    );

    return { success: true };
  }

  @HasuraAction()
  public async draftTournamentTeams(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (TournamentsController.BRACKET_IN_PLAY.includes(tournament.status)) {
      throw Error("cannot draft teams once the tournament is live");
    }

    if (!["free_agents", "both"].includes(tournament.registration_type)) {
      throw Error("this tournament does not accept free agents");
    }

    const [drafted] = await this.postgres.query<
      Array<{ teams_created: number }>
    >(`SELECT draft_tournament_free_agent_teams($1::uuid) AS teams_created`, [
      tournament_id,
    ]);

    // The same order tau_tournaments uses: the bracket is sized from the live
    // team count, so seeding before the draft would build it for zero teams.
    await this.postgres.query(`SELECT update_tournament_stages($1::uuid)`, [
      tournament_id,
    ]);
    await this.postgres.query(
      `SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1::uuid`,
      [tournament_id],
    );
    await this.postgres.query(
      `SELECT seed_stage(ts.id)
         FROM tournament_stages ts
        WHERE ts.tournament_id = $1::uuid AND ts."order" = 1`,
      [tournament_id],
    );

    this.logger.log(
      `[${tournament_id}] drafted ${drafted.teams_created} free agent teams`,
    );

    return { teams_created: drafted.teams_created };
  }

  @HasuraAction()
  public async joinTournamentAsFreeAgent(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    if (!["free_agents", "both"].includes(tournament.registration_type)) {
      throw Error("this tournament only accepts pre-formed teams");
    }

    if (tournament.status !== "RegistrationOpen") {
      throw Error("registration is not open");
    }

    this.requireRegistrationUnlocked(tournament);

    const [eligible] = await this.postgres.query<Array<{ ok: boolean }>>(
      `SELECT player_meets_tournament_requirements($1::uuid, $2::bigint) AS ok`,
      [tournament_id, data.user.steam_id],
    );

    if (!eligible?.ok) {
      throw Error("you do not meet this tournament's entry requirements");
    }

    await this.postgres.query(
      `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
       VALUES ($1::uuid, $2::bigint)
       ON CONFLICT (tournament_id, player_steam_id) DO NOTHING`,
      [tournament_id, data.user.steam_id],
    );

    return { success: true };
  }

  @HasuraAction()
  public async leaveTournamentAsFreeAgent(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    if (!["Setup", "RegistrationOpen"].includes(tournament.status)) {
      throw Error("the free agent pool is closed");
    }

    const removed = await this.postgres.query<Array<{ id: string }>>(
      `DELETE FROM tournament_free_agents
        WHERE tournament_id = $1::uuid AND player_steam_id = $2::bigint
      RETURNING id::text AS id`,
      [tournament_id, data.user.steam_id],
    );

    if (removed.length === 0) {
      throw Error("you are not in this tournament's free agent pool");
    }

    return { success: true };
  }

  private requireRegistrationUnlocked(tournament: TournamentAccess) {
    if (!tournament.invite_only) {
      return;
    }

    if (tournament.is_organizer || tournament.unlocked) {
      return;
    }

    throw Error("this tournament is invite only");
  }

  @HasuraAction()
  public async unlockTournamentRegistration(data: {
    user: User;
    tournament_id: string;
    passcode: string;
  }) {
    const { tournament_id, passcode } = data;

    // Compared in SQL so the passcode never has to be read back out of the
    // database and into a log or an error message.
    const [tournament] = await this.postgres.query<
      Array<{ status: string; matches: boolean; has_passcode: boolean }>
    >(
      `SELECT t.status,
              t.registration_passcode IS NOT NULL AND t.registration_passcode <> '' AS has_passcode,
              lower(btrim(COALESCE(t.registration_passcode, ''))) = lower(btrim($2::text)) AS matches
         FROM tournaments t
        WHERE t.id = $1::uuid`,
      [tournament_id, passcode ?? ""],
    );

    if (!tournament) {
      throw Error("tournament not found");
    }

    if (!["Setup", "RegistrationOpen"].includes(tournament.status)) {
      throw Error("registration is not open");
    }

    if (!tournament.has_passcode) {
      throw Error("this tournament does not use a passcode");
    }

    if (!tournament.matches) {
      throw Error("incorrect passcode");
    }

    await this.postgres.query(
      `INSERT INTO tournament_registration_unlocks (tournament_id, player_steam_id)
       VALUES ($1::uuid, $2::bigint)
       ON CONFLICT (tournament_id, player_steam_id) DO NOTHING`,
      [tournament_id, data.user.steam_id],
    );

    return { success: true };
  }
}
