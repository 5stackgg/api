import { Controller } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";

@Controller("invites")
export class InvitesController {
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

    if (type === "match") {
      return await this.acceptMatchInvite(invite_id, user);
    }

    return await this.acceptTournamentTeamInvite(invite_id, user);
  }

  private async acceptMatchInvite(invite_id: string, user: User) {
    const { match_invites_by_pk } = await this.hasura.query({
      match_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        match_id: true,
        steam_id: true,
        invited_by_player_steam_id: true,
      },
    });

    if (!match_invites_by_pk) {
      throw Error("unable to find match invite");
    }

    if (match_invites_by_pk?.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: match_invites_by_pk.match_id,
        },
        id: true,
        options: {
          type: true,
        },
        lineup_1: {
          id: true,
          lineup_players: {
            steam_id: true,
          },
        },
        lineup_2: {
          id: true,
          lineup_players: {
            steam_id: true,
          },
        },
        max_players_per_lineup: true,
      },
    });

    if (!matches_by_pk) {
      throw Error("unable to find match");
    }

    const { lineup_1, lineup_2 } = matches_by_pk;

    let friendsLineup;
    if (
      lineup_1.lineup_players.find(
        (player) =>
          player.steam_id === match_invites_by_pk.invited_by_player_steam_id,
      )
    ) {
      friendsLineup = lineup_1;
    } else if (
      lineup_2.lineup_players.find(
        (player) =>
          player.steam_id === match_invites_by_pk.invited_by_player_steam_id,
      )
    ) {
      friendsLineup = lineup_2;
    }

    if (!friendsLineup) {
      friendsLineup = lineup_1;
    }

    let lineupId = friendsLineup.id;
    if (
      friendsLineup.lineup_players.length >=
      matches_by_pk.max_players_per_lineup
    ) {
      const otherLineup =
        lineup_1.id === friendsLineup.id ? lineup_2 : lineup_1;
      lineupId = otherLineup.id;
    }

    const { insert_match_lineup_players_one } = await this.hasura.mutation({
      insert_match_lineup_players_one: {
        __args: {
          object: {
            steam_id: user.steam_id,
            match_lineup_id: lineupId,
          },
        },
        id: true,
      },
    });

    if (!insert_match_lineup_players_one?.id) {
      throw Error("unable to insert match lineup player");
    }

    await this.hasura.mutation({
      delete_match_invites_by_pk: {
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

  private async denyMatchInvite(invite_id: string, user: User) {
    const { match_invites_by_pk } = await this.hasura.query({
      match_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        steam_id: true,
      },
    });

    if (!match_invites_by_pk) {
      throw Error("unable to find match invite");
    }

    if (match_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      delete_match_invites_by_pk: {
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

    if (type === "match") {
      return this.denyMatchInvite(invite_id, user);
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
