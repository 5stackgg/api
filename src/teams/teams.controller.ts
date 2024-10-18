import { Controller } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";

@Controller("teams")
export class TeamsController {
  constructor(private readonly hasura: HasuraService) {}

  @HasuraAction()
  public async acceptInvite(data: {
    user: User;
    invite_id: string;
    type: string;
  }) {
    const { invite_id, user, type } = data;

    if (type === "team") {
      return await this.acceptTeamInvite(invite_id, user);
    }

    return await this.acceptTournamentTeamInvite(invite_id, user);
  }

  private async acceptTeamInvite(invite_id: string, user: User) {
    const { team_invites_by_pk } = await this.hasura.query({
      team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        team_id: true,
        steam_id: true,
      },
    });

    if (!team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (team_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      insert_team_roster_one: {
        __args: {
          object: {
            role: "Member",
            team_id: team_invites_by_pk.team_id,
            player_steam_id: user.steam_id,
          },
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      delete_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  private async acceptTournamentTeamInvite(invite_id: string, user: User) {
    const { tournament_team_invites_by_pk } = await this.hasura.query({
      tournament_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        steam_id: true,
        tournament_team_id: true,
        team: {
          tournament_id: true,
        },
      },
    });

    if (!tournament_team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (tournament_team_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      insert_tournament_team_roster_one: {
        __args: {
          object: {
            role: "Member",
            tournament_id: tournament_team_invites_by_pk.team.tournament_id,
            tournament_team_id:
              tournament_team_invites_by_pk.tournament_team_id,
            player_steam_id: user.steam_id,
          },
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      delete_tournament_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async denyInvite(data: {
    user: User;
    invite_id: string;
    type: string;
  }) {
    const { invite_id, user, type } = data;

    if (type === "team") {
      return this.denyTeamInvite(invite_id, user);
    }

    return this.denyTournamentTeamInvite(invite_id, user);
  }

  public async denyTeamInvite(invite_id: string, user: User) {
    const { team_invites_by_pk } = await this.hasura.query({
      team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        team_id: true,
        steam_id: true,
      },
    });

    if (!team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (team_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      delete_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  public async denyTournamentTeamInvite(invite_id: string, user: User) {
    const { tournament_team_invites_by_pk } = await this.hasura.query({
      tournament_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        steam_id: true,
        tournament_team_id: true,
        team: {
          tournament_id: true,
        },
      },
    });

    if (!tournament_team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (tournament_team_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      delete_tournament_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }
}
