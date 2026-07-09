import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PostgresService } from "../postgres/postgres.service";
import { AppConfig } from "../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "generated/schema";

type BracketContext = {
  bracket_id: string;
  week_number: number;
  league_season_id: string;
  season_name: string;
  team_1_league_team_season_id: string | null;
  team_1_team_id: string | null;
  team_1_name: string | null;
  team_2_league_team_season_id: string | null;
  team_2_team_id: string | null;
  team_2_name: string | null;
};

@Injectable()
export class LeaguesService {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    configService: ConfigService,
  ) {
    this.appConfig = configService.get<AppConfig>("app");
  }

  public async getBracketContext(
    bracketId: string,
  ): Promise<BracketContext | null> {
    const rows = await this.postgres.query<Array<BracketContext>>(
      `SELECT tb.id AS bracket_id,
              tb.round AS week_number,
              ls.id AS league_season_id,
              ls.name AS season_name,
              lts1.id AS team_1_league_team_season_id,
              tt1.team_id AS team_1_team_id,
              tt1.name AS team_1_name,
              lts2.id AS team_2_league_team_season_id,
              tt2.team_id AS team_2_team_id,
              tt2.name AS team_2_name
         FROM tournament_brackets tb
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         JOIN league_season_divisions lsd ON lsd.tournament_id = ts.tournament_id
         JOIN league_seasons ls ON ls.id = lsd.league_season_id
         LEFT JOIN tournament_teams tt1 ON tt1.id = tb.tournament_team_id_1
         LEFT JOIN tournament_teams tt2 ON tt2.id = tb.tournament_team_id_2
         LEFT JOIN league_team_seasons lts1
           ON lts1.tournament_team_id = tb.tournament_team_id_1
         LEFT JOIN league_team_seasons lts2
           ON lts2.tournament_team_id = tb.tournament_team_id_2
        WHERE tb.id = $1`,
      [bracketId],
    );
    return rows.at(0) ?? null;
  }

  private async getLeagueTeamManagers(
    leagueTeamSeasonId: string,
  ): Promise<Array<string>> {
    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT steam_id::text AS steam_id FROM (
          SELECT t.owner_steam_id AS steam_id
            FROM league_team_seasons lts
            JOIN league_teams lt ON lt.id = lts.league_team_id
            JOIN teams t ON t.id = lt.team_id
           WHERE lts.id = $1 AND t.owner_steam_id IS NOT NULL
          UNION
          SELECT tr.player_steam_id
            FROM league_team_seasons lts
            JOIN league_teams lt ON lt.id = lts.league_team_id
            JOIN team_roster tr ON tr.team_id = lt.team_id AND tr.role = 'Admin'
           WHERE lts.id = $1
          UNION
          SELECT lts.captain_steam_id
            FROM league_team_seasons lts
           WHERE lts.id = $1 AND lts.captain_steam_id IS NOT NULL
        ) managers`,
      [leagueTeamSeasonId],
    );
    return rows.map(({ steam_id }) => steam_id);
  }

  private seasonUrl(context: { league_season_id: string }): string {
    return `${this.appConfig.webDomain}/leagues/seasons/${context.league_season_id}?tab=schedule`;
  }

  public async notifyManagers(params: {
    leagueTeamSeasonIds: Array<string | null>;
    excludeSteamId?: string | null;
    type: string;
    title: string;
    message: string;
    entityId: string;
  }): Promise<number> {
    const recipients = new Set<string>();
    for (const leagueTeamSeasonId of params.leagueTeamSeasonIds) {
      if (!leagueTeamSeasonId) {
        continue;
      }
      for (const steamId of await this.getLeagueTeamManagers(
        leagueTeamSeasonId,
      )) {
        recipients.add(steamId);
      }
    }
    if (params.excludeSteamId) {
      recipients.delete(String(params.excludeSteamId));
    }
    if (recipients.size === 0) {
      return 0;
    }

    await this.hasura.mutation({
      insert_notifications: {
        __args: {
          objects: Array.from(recipients).map((steamId) => ({
            type: params.type as e_notification_types_enum,
            title: params.title,
            message: params.message,
            role: "user" as e_player_roles_enum,
            steam_id: steamId,
            entity_id: params.entityId,
          })),
        },
        affected_rows: true,
      },
    });

    return recipients.size;
  }

  public matchupLabel(context: BracketContext): string {
    const team1 = NotificationsService.escapeHtml(context.team_1_name ?? "TBD");
    const team2 = NotificationsService.escapeHtml(context.team_2_name ?? "TBD");
    const url = this.seasonUrl(context);
    return `<a href="${url}">${team1} vs ${team2}</a> (${NotificationsService.escapeHtml(
      context.season_name,
    )}, week ${context.week_number})`;
  }

  public async handleProposalEvent(params: {
    op: "INSERT" | "UPDATE";
    bracketId: string;
    proposedBySteamId: string;
    proposedByLeagueTeamSeasonId: string | null;
    proposedTime: string;
    oldStatus?: string | null;
    newStatus: string;
  }): Promise<void> {
    const context = await this.getBracketContext(params.bracketId);
    if (!context) {
      return;
    }

    const time = new Date(params.proposedTime).toUTCString();
    const matchup = this.matchupLabel(context);

    if (params.op === "INSERT") {
      const opposing = [
        context.team_1_league_team_season_id,
        context.team_2_league_team_season_id,
      ].filter((id) => id && id !== params.proposedByLeagueTeamSeasonId);

      const count = await this.notifyManagers({
        leagueTeamSeasonIds: opposing.length
          ? opposing
          : [
              context.team_1_league_team_season_id,
              context.team_2_league_team_season_id,
            ],
        excludeSteamId: params.proposedBySteamId,
        type: "LeagueProposalReceived",
        title: "League Match Time Proposed",
        message: `A time of ${time} was proposed for ${matchup}. Accept or counter it.`,
        entityId: params.bracketId,
      });
      this.logger.log(
        `[league] proposal received notice sent to ${count} manager(s) for bracket ${params.bracketId}`,
      );
      return;
    }

    if (
      params.oldStatus === "Pending" &&
      ["Accepted", "Declined"].includes(params.newStatus)
    ) {
      const accepted = params.newStatus === "Accepted";
      const count = await this.notifyManagers({
        leagueTeamSeasonIds: [params.proposedByLeagueTeamSeasonId],
        type: accepted ? "LeagueProposalAccepted" : "LeagueProposalDeclined",
        title: accepted
          ? "League Match Time Accepted"
          : "League Match Time Declined",
        message: accepted
          ? `Your proposed time of ${time} was accepted for ${matchup}.`
          : `Your proposed time of ${time} was declined for ${matchup}.`,
        entityId: params.bracketId,
      });
      this.logger.log(
        `[league] proposal ${params.newStatus} notice sent to ${count} manager(s) for bracket ${params.bracketId}`,
      );
    }
  }

  public async handleRegistrationEvent(params: {
    leagueTeamSeasonId: string;
    oldStatus?: string | null;
    newStatus: string;
    oldAssignedDivisionId?: string | null;
    newAssignedDivisionId?: string | null;
  }): Promise<void> {
    const isDecision =
      ["Approved", "Declined", "Waitlisted"].includes(params.newStatus) &&
      params.oldStatus !== params.newStatus;
    const isReassignment =
      params.newStatus === "Approved" &&
      params.oldStatus === params.newStatus &&
      !!params.newAssignedDivisionId &&
      params.newAssignedDivisionId !== params.oldAssignedDivisionId;
    const isRevocation =
      params.newStatus === "Withdrawn" &&
      params.oldStatus === "Approved";

    if (!isDecision && !isReassignment && !isRevocation) {
      return;
    }

    const rows = await this.postgres.query<
      Array<{
        league_season_id: string;
        season_name: string;
        team_name: string;
        division_name: string | null;
        decline_reason: string | null;
      }>
    >(
      `SELECT ls.id AS league_season_id,
              ls.name AS season_name,
              t.name AS team_name,
              ld.name AS division_name,
              lts.decline_reason
         FROM league_team_seasons lts
         JOIN league_seasons ls ON ls.id = lts.league_season_id
         JOIN league_teams lt ON lt.id = lts.league_team_id
         JOIN teams t ON t.id = lt.team_id
         LEFT JOIN league_divisions ld ON ld.id = lts.assigned_division_id
        WHERE lts.id = $1`,
      [params.leagueTeamSeasonId],
    );
    const context = rows.at(0);
    if (!context) {
      return;
    }

    const url = `${this.appConfig.webDomain}/leagues/seasons/${context.league_season_id}`;
    const team = NotificationsService.escapeHtml(context.team_name);
    const season = NotificationsService.escapeHtml(context.season_name);

    const division = context.division_name
      ? NotificationsService.escapeHtml(context.division_name)
      : "";

    const message = isReassignment
      ? `${team} was moved to ${division} in <a href="${url}">${season}</a>.`
      : isRevocation
        ? `${team} was removed from <a href="${url}">${season}</a>.${
            context.decline_reason
              ? ` Reason: ${NotificationsService.escapeHtml(context.decline_reason)}`
              : ""
          }`
        : params.newStatus === "Approved"
          ? `${team} was approved for <a href="${url}">${season}</a>${
              division ? ` and placed in ${division}` : ""
            }.`
          : params.newStatus === "Waitlisted"
            ? `${team} was waitlisted for <a href="${url}">${season}</a>.`
            : `${team} was declined for <a href="${url}">${season}</a>.${
                context.decline_reason
                  ? ` Reason: ${NotificationsService.escapeHtml(context.decline_reason)}`
                  : ""
              }`;

    const count = await this.notifyManagers({
      leagueTeamSeasonIds: [params.leagueTeamSeasonId],
      type: "LeagueRegistrationDecision",
      title: "League Registration Update",
      message,
      entityId: params.leagueTeamSeasonId,
    });
    this.logger.log(
      `[league] registration ${isReassignment ? "reassignment" : params.newStatus} notice sent to ${count} manager(s) for ${params.leagueTeamSeasonId}`,
    );
  }

  public async handleRosterChange(leagueTeamSeasonId: string): Promise<void> {
    const rows = await this.postgres.query<
      Array<{
        league_season_id: string;
        season_name: string;
        team_name: string;
        registration_status: string;
        season_status: string;
        active_count: number;
        min_roster: number;
      }>
    >(
      `SELECT ls.id AS league_season_id,
              ls.name AS season_name,
              t.name AS team_name,
              lts.status AS registration_status,
              ls.status AS season_status,
              (
                SELECT COUNT(*) FROM league_team_rosters ltr
                 WHERE ltr.league_team_season_id = lts.id
                   AND ltr.removed_at IS NULL
              ) AS active_count,
              COALESCE(ls.min_roster_size, public.team_min_roster_size()) AS min_roster
         FROM league_team_seasons lts
         JOIN league_seasons ls ON ls.id = lts.league_season_id
         JOIN league_teams lt ON lt.id = lts.league_team_id
         JOIN teams t ON t.id = lt.team_id
        WHERE lts.id = $1`,
      [leagueTeamSeasonId],
    );
    const context = rows.at(0);
    if (!context) {
      return;
    }

    if (
      context.registration_status !== "Approved" ||
      !["Setup", "RegistrationOpen", "RegistrationClosed"].includes(
        context.season_status,
      ) ||
      Number(context.active_count) >= Number(context.min_roster)
    ) {
      return;
    }

    const url = `${this.appConfig.webDomain}/leagues/seasons/${context.league_season_id}`;
    const team = NotificationsService.escapeHtml(context.team_name);
    const season = NotificationsService.escapeHtml(context.season_name);
    const message = `${team} now has ${context.active_count} of the required ${context.min_roster} players for <a href="${url}">${season}</a>. Add players before the league starts or the team will be revoked at kickoff.`;

    const count = await this.notifyManagers({
      leagueTeamSeasonIds: [leagueTeamSeasonId],
      type: "LeagueRosterUndersized",
      title: "League Roster Below Minimum",
      message,
      entityId: leagueTeamSeasonId,
    });
    this.logger.log(
      `[league] undersized roster notice sent to ${count} manager(s) for ${leagueTeamSeasonId}`,
    );
  }
}
