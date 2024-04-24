import { Controller } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction } from "../hasura/actions/actions.controller";
import { User } from "../auth/types/User";
import { e_team_roles_enum } from "../../generated/zeus";

@Controller("teams")
export class TeamsController {
  constructor(private readonly hasura: HasuraService) {}

  @HasuraAction()
  public async acceptTeamInvite(data: { user: User; invite_id: string }) {
    const { invite_id, user } = data;

    const { team_invites_by_pk } = await this.hasura.query({
      team_invites_by_pk: [
        {
          id: invite_id,
        },
        {
          team_id: true,
          steam_id: true,
        },
      ],
    });

    if (!team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (team_invites_by_pk.steam_id.toString() !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      insert_team_roster_one: [
        {
          object: {
            role: e_team_roles_enum.Member,
            team_id: team_invites_by_pk.team_id,
            player_steam_id: user.steam_id,
          },
        },
        {
          team_id: true,
        },
      ],
    });

    await this.hasura.mutation({
      delete_team_invites_by_pk: [
        {
          id: invite_id,
        },
        {
          id: true,
        },
      ],
    });

    return {
      success: true,
    };
  }
}
