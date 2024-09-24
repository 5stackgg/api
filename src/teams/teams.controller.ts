import { Controller } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";

@Controller("teams")
export class TeamsController {
  constructor(private readonly hasura: HasuraService) {}

  @HasuraAction()
  public async acceptTeamInvite(data: { user: User; invite_id: string }) {
    const { invite_id, user } = data;

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

  @HasuraAction()
  public async denyTeamInvite(data: { user: User; invite_id: string }) {
    const { invite_id, user } = data;

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
}
