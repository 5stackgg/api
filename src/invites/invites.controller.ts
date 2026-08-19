import { Controller, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { e_notification_types_enum } from "generated/schema";
import { User } from "../auth/types/User";

@Controller("invites")
export class InvitesController {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
  ) {}

  // Invites arrive as direct GraphQL inserts from the web, so a table trigger
  // is the only hook that catches every path that can create one.
  //
  // Each handler re-reads the row by its uuid rather than trusting the event
  // payload: Hasura serialises bigints as JSON numbers, and every steam id is
  // far past the point where that stays exact.
  @HasuraEvent()
  public async team_invite_events(data: HasuraEventData<{ id: string }>) {
    if (data.op !== "INSERT") {
      return;
    }

    const [invite] = await this.postgres.query<
      Array<{
        steam_id: string;
        team_name: string;
        team_avatar: string | null;
        invited_by: string;
      }>
    >(
      `SELECT ti.steam_id::text AS steam_id,
              t.name AS team_name,
              t.avatar_url AS team_avatar,
              COALESCE(p.name, 'Someone') AS invited_by
         FROM public.team_invites ti
         JOIN public.teams t ON t.id = ti.team_id
    LEFT JOIN public.players p ON p.steam_id = ti.invited_by_player_steam_id
        WHERE ti.id = $1::uuid`,
      [data.new.id],
    );

    if (!invite) {
      return;
    }

    await this.notifyInvited("TeamInvite", {
      steamId: invite.steam_id,
      title: "Team Invite",
      body: `<b>${NotificationsService.escapeHtml(invite.invited_by)}</b> invited you to <b>${NotificationsService.escapeHtml(invite.team_name)}</b>.`,
      entityId: data.new.id,
      icon: invite.team_avatar,
    });
  }

  @HasuraEvent()
  public async tournament_team_invite_events(
    data: HasuraEventData<{ id: string }>,
  ) {
    if (data.op !== "INSERT") {
      return;
    }

    const [invite] = await this.postgres.query<
      Array<{
        steam_id: string;
        team_name: string;
        tournament_name: string;
        tournament_logo: string | null;
        invited_by: string;
      }>
    >(
      `SELECT tti.steam_id::text AS steam_id,
              tt.name AS team_name,
              tour.name AS tournament_name,
              tour.logo AS tournament_logo,
              COALESCE(p.name, 'Someone') AS invited_by
         FROM public.tournament_team_invites tti
         JOIN public.tournament_teams tt ON tt.id = tti.tournament_team_id
         JOIN public.tournaments tour ON tour.id = tt.tournament_id
    LEFT JOIN public.players p ON p.steam_id = tti.invited_by_player_steam_id
        WHERE tti.id = $1::uuid`,
      [data.new.id],
    );

    if (!invite) {
      return;
    }

    await this.notifyInvited("TournamentTeamInvite", {
      steamId: invite.steam_id,
      title: "Tournament Invite",
      body: `<b>${NotificationsService.escapeHtml(invite.invited_by)}</b> invited you to play for <b>${NotificationsService.escapeHtml(invite.team_name)}</b> in <b>${NotificationsService.escapeHtml(invite.tournament_name)}</b>.`,
      entityId: data.new.id,
      icon: invite.tournament_logo,
    });
  }

  public async notifyInvited(
    type: e_notification_types_enum,
    invite: {
      steamId: string;
      title: string;
      body: string;
      entityId: string;
      // Whose crest the push shows: the team's or the tournament's.
      icon?: string | null;
    },
  ) {
    try {
      await this.notifications.notifyPlayers(type, {
        title: invite.title,
        message: invite.body,
        role: "user",
        entity_id: invite.entityId,
        steamIds: [invite.steamId],
        data: { icon: invite.icon },
      });
    } catch (error) {
      // The invite itself is already written; losing its notification must not
      // surface as a failed insert to whoever sent it.
      this.logger.warn(`unable to notify of ${type} ${invite.entityId}`, error);
    }
  }

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
          on_conflict: {
            constraint: "tournament_roster_pkey",
            update_columns: ["role"],
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
