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
      steamIds: [invite.steam_id],
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
      steamIds: [invite.steam_id],
      title: "Tournament Invite",
      body: `<b>${NotificationsService.escapeHtml(invite.invited_by)}</b> invited you to play for <b>${NotificationsService.escapeHtml(invite.team_name)}</b> in <b>${NotificationsService.escapeHtml(invite.tournament_name)}</b>.`,
      entityId: data.new.id,
      icon: invite.tournament_logo,
    });
  }

  @HasuraEvent()
  public async tournament_invite_events(data: HasuraEventData<{ id: string }>) {
    if (data.op !== "INSERT") {
      return;
    }

    const [invite] = await this.postgres.query<
      Array<{
        steam_id: string | null;
        team_id: string | null;
        team_name: string | null;
        tournament_name: string;
        tournament_logo: string | null;
        invited_by: string;
      }>
    >(
      `SELECT ti.steam_id::text AS steam_id,
              ti.team_id::text AS team_id,
              team.name AS team_name,
              tour.name AS tournament_name,
              tour.logo AS tournament_logo,
              COALESCE(p.name, 'Someone') AS invited_by
         FROM public.tournament_invites ti
         JOIN public.tournaments tour ON tour.id = ti.tournament_id
    LEFT JOIN public.teams team ON team.id = ti.team_id
    LEFT JOIN public.players p ON p.steam_id = ti.invited_by_player_steam_id
        WHERE ti.id = $1::uuid`,
      [data.new.id],
    );

    if (!invite) {
      return;
    }

    // A team-addressed invite has nobody to tell on the row itself, so it goes
    // to the people who could act on it -- the same owner / captain / roster
    // Admin the unlock will answer for.
    const steamIds = invite.team_id
      ? await this.teamRegistrars(invite.team_id)
      : [invite.steam_id!];

    if (steamIds.length === 0) {
      return;
    }

    await this.notifyInvited("TournamentInvite", {
      steamIds,
      title: "Tournament Invite",
      body: invite.team_id
        ? `<b>${NotificationsService.escapeHtml(invite.invited_by)}</b> invited <b>${NotificationsService.escapeHtml(invite.team_name ?? "your team")}</b> to register for <b>${NotificationsService.escapeHtml(invite.tournament_name)}</b>.`
        : `<b>${NotificationsService.escapeHtml(invite.invited_by)}</b> invited you to register for <b>${NotificationsService.escapeHtml(invite.tournament_name)}</b>.`,
      entityId: data.new.id,
      icon: invite.tournament_logo,
    });
  }

  // Owner, captain and roster Admins: exactly the people
  // tournament_registration_unlocked() treats as able to register the team, so
  // the invite reaches whoever can actually accept it.
  private async teamRegistrars(teamId: string): Promise<Array<string>> {
    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT steam_id::text AS steam_id
         FROM (
             SELECT t.owner_steam_id AS steam_id FROM public.teams t WHERE t.id = $1::uuid
              UNION
             SELECT t.captain_steam_id FROM public.teams t WHERE t.id = $1::uuid
              UNION
             SELECT tr.player_steam_id
               FROM public.team_roster tr
              WHERE tr.team_id = $1::uuid AND tr.role = 'Admin'
         ) registrars
        WHERE steam_id IS NOT NULL`,
      [teamId],
    );

    return rows.map((row) => row.steam_id);
  }

  public async notifyInvited(
    type: e_notification_types_enum,
    invite: {
      steamIds: Array<string>;
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
        steamIds: invite.steamIds,
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

    switch (type) {
      case "team":
        return await this.acceptTeamInvite(invite_id, user);
      // "tournament" has meant the tournament TEAM invite since long before
      // tournament_invites existed and deployed clients still send it, so the
      // new table gets its own key rather than stealing that one.
      case "tournament":
      case "tournament-team":
        return await this.acceptTournamentTeamInvite(invite_id, user);
      case "tournament-registration":
        return await this.acceptTournamentInvite(invite_id, user);
    }

    // This used to fall through to the tournament-team branch, which turned a
    // typo into a lookup against the wrong table.
    throw Error(`unknown invite type ${type}`);
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

  // The window an invite can still be acted on in, matching the one the invite
  // links are minted and redeemed in.
  private static readonly REGISTRATION_STATUSES = ["Setup", "RegistrationOpen"];

  // Steam ids are read back as text for the same reason the event handlers do
  // it: a bigint that round-trips through JSON stops being exact well below a
  // steam id.
  //
  // The refusals a player can be handed off a tournament invite are thrown as
  // codes, not sentences, for the reason redeemTournamentInviteCode is: an
  // action's error reaches the client as `message` and nothing else, so the code
  // has to BE the message for the browser to have anything to translate. The
  // team-invite branches keep their prose -- web renders an unrecognised message
  // verbatim, so a refusal outside this contract still says something.
  private async findTournamentInvite(invite_id: string) {
    const [invite] = await this.postgres.query<
      Array<{
        tournament_id: string;
        steam_id: string | null;
        team_id: string | null;
        status: string;
      }>
    >(
      `SELECT ti.tournament_id,
              ti.steam_id::text AS steam_id,
              ti.team_id::text AS team_id,
              t.status
         FROM public.tournament_invites ti
         JOIN public.tournaments t ON t.id = ti.tournament_id
        WHERE ti.id = $1::uuid`,
      [invite_id],
    );

    if (!invite) {
      throw Error("invite_not_found");
    }

    return invite;
  }

  // The row is addressed to exactly one of a player or a team
  // (tournament_invites_addressed_once), and who may answer it follows from
  // which: the player themselves, or anyone who could register that team.
  private async canAnswerTournamentInvite(
    invite: { steam_id: string | null; team_id: string | null },
    user: User,
  ): Promise<boolean> {
    if (invite.team_id === null) {
      return invite.steam_id === user.steam_id;
    }

    const registrars = await this.teamRegistrars(invite.team_id);

    return registrars.includes(user.steam_id);
  }

  private async acceptTournamentInvite(invite_id: string, user: User) {
    const invite = await this.findTournamentInvite(invite_id);

    // An invite outlives the window it was sent in, so the trigger that gates
    // handing one out cannot be the whole answer: accepting is the write that
    // grants access, and granting it against an already-seeded bracket is what
    // this refuses. Declining stays open -- clearing an invite off the bell is
    // not registering for anything.
    if (!InvitesController.REGISTRATION_STATUSES.includes(invite.status)) {
      throw Error("invite_registration_closed");
    }

    if (!(await this.canAnswerTournamentInvite(invite, user))) {
      return {
        success: false,
      };
    }

    // An unlock row is what tbi_tournament_team and tbi_tournament_free_agents
    // already check, so the invite grants exactly what an invite code grants
    // rather than becoming a second gate they would both have to learn about.
    // ON CONFLICT because the player may have redeemed a code first.
    //
    // A team invite writes the team-scoped half: the team gets to register, and
    // its members do not each get a free-agent slot out of it.
    await this.postgres.query(
      `INSERT INTO public.tournament_registration_unlocks (tournament_id, player_steam_id, team_id)
       VALUES ($1::uuid, $2::bigint, $3::uuid)
       ON CONFLICT DO NOTHING`,
      [invite.tournament_id, invite.steam_id, invite.team_id],
    );

    await this.postgres.query(
      "DELETE FROM public.tournament_invites WHERE id = $1::uuid",
      [invite_id],
    );

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

    switch (type) {
      case "team":
        return this.denyTeamInvite(invite_id, user);
      case "tournament":
      case "tournament-team":
        return this.denyTournamentTeamInvite(invite_id, user);
      case "tournament-registration":
        return this.denyTournamentInvite(invite_id, user);
    }

    throw Error(`unknown invite type ${type}`);
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

  public async denyTournamentInvite(invite_id: string, user: User) {
    const invite = await this.findTournamentInvite(invite_id);

    if (!(await this.canAnswerTournamentInvite(invite, user))) {
      return {
        success: false,
      };
    }

    // Only the invite goes; a declined invite never granted an unlock, and
    // deleting one here would revoke a code the player redeemed themselves.
    await this.postgres.query(
      "DELETE FROM public.tournament_invites WHERE id = $1::uuid",
      [invite_id],
    );

    return {
      success: true,
    };
  }
}
