import { Controller, Logger } from "@nestjs/common";
import { HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { LeaguesService } from "./leagues.service";

// The league tables are newer than the generated GraphQL types; event
// payloads are typed locally.
type LeagueSchedulingProposalRow = {
  id?: string;
  tournament_bracket_id?: string;
  proposed_by_steam_id?: string;
  proposed_by_league_team_season_id?: string | null;
  proposed_time?: string;
  status?: string;
};

type LeagueTeamSeasonRow = {
  id?: string;
  status?: string;
  assigned_division_id?: string | null;
};

type LeagueTeamRosterRow = {
  league_team_season_id?: string;
  player_steam_id?: string;
  removed_at?: string | null;
};

@Controller("leagues")
export class LeaguesController {
  constructor(
    private readonly logger: Logger,
    private readonly leagues: LeaguesService,
  ) {}

  @HasuraEvent()
  public async league_proposal_events(
    data: HasuraEventData<LeagueSchedulingProposalRow>,
  ) {
    try {
      await this.leagues.handleProposalEvent({
        op: data.op === "INSERT" ? "INSERT" : "UPDATE",
        bracketId: (data.new.tournament_bracket_id ||
          data.old?.tournament_bracket_id) as string,
        proposedBySteamId: String(
          data.new.proposed_by_steam_id ?? data.old?.proposed_by_steam_id ?? "",
        ),
        proposedByLeagueTeamSeasonId:
          // data.old is null on INSERT (admin-created proposals leave the
          // proposer team null, so the ?? chain reaches it).
          data.new.proposed_by_league_team_season_id ??
          data.old?.proposed_by_league_team_season_id ??
          null,
        proposedTime: (data.new.proposed_time ||
          data.old?.proposed_time) as string,
        oldStatus: data.old?.status ?? null,
        newStatus: data.new.status as string,
      });
    } catch (error) {
      this.logger.error("unable to send league proposal notification", error);
    }
  }

  @HasuraEvent()
  public async league_registration_events(
    data: HasuraEventData<LeagueTeamSeasonRow>,
  ) {
    try {
      await this.leagues.handleRegistrationEvent({
        leagueTeamSeasonId: (data.new.id || data.old?.id) as string,
        oldStatus: data.old?.status ?? null,
        newStatus: data.new.status as string,
        oldAssignedDivisionId: data.old?.assigned_division_id ?? null,
        newAssignedDivisionId: data.new.assigned_division_id ?? null,
      });
    } catch (error) {
      this.logger.error(
        "unable to send league registration notification",
        error,
      );
    }
  }

  @HasuraEvent()
  public async league_roster_events(
    data: HasuraEventData<LeagueTeamRosterRow>,
  ) {
    // Only a soft-remove (a player leaving the active roster) can drop a team
    // below the minimum; a fresh insert or a revive never does.
    const becameRemoved =
      !!data.new.removed_at &&
      (data.op === "INSERT" || !data.old?.removed_at);
    if (!becameRemoved) {
      return;
    }

    try {
      await this.leagues.handleRosterChange(
        (data.new.league_team_season_id ||
          data.old?.league_team_season_id) as string,
      );
    } catch (error) {
      this.logger.error(
        "unable to send league roster notification",
        error,
      );
    }
  }
}
