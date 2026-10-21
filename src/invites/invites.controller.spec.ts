import { InvitesController } from "./invites.controller";
import { User } from "../auth/types/User";

describe("InvitesController accepting a tournament team invite", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const hasura = { query: jest.fn(), mutation: jest.fn() };
  const postgres = { query: jest.fn() };
  const notifications = { notifyPlayers: jest.fn() };

  const player: User = {
    name: "Player",
    role: "user",
    steam_id: "76561190000000001",
  };

  let seat: Array<{ tournament_team_id: string }>;
  let team: Array<{
    joins_team: boolean;
    member: boolean;
    inviter_can_invite: boolean;
  }>;

  const controller = () =>
    new InvitesController(
      logger as never,
      hasura as never,
      postgres as never,
      notifications as never,
    );

  const accept = () =>
    controller().acceptInvite({
      user: player,
      invite_id: "invite-1",
      type: "tournament-team",
    });

  const mutated = (field: string) =>
    hasura.mutation.mock.calls.some(([mutation]) => field in mutation);

  beforeEach(() => {
    jest.resetAllMocks();
    seat = [];
    team = [{ joins_team: true, member: false, inviter_can_invite: true }];
    hasura.query.mockResolvedValue({
      tournament_team_invites_by_pk: {
        steam_id: player.steam_id,
        tournament_team_id: "inviting-team",
        team: { tournament_id: "tournament-1" },
      },
    });
    hasura.mutation.mockResolvedValue({});
    postgres.query.mockImplementation(async (sql: string) =>
      sql.includes("can_invite_to_team") ? team : seat,
    );
  });

  const backedByTeam = () =>
    hasura.query.mockResolvedValue({
      tournament_team_invites_by_pk: {
        steam_id: player.steam_id,
        tournament_team_id: "inviting-team",
        team: { tournament_id: "tournament-1", team_id: "team-1" },
      },
    });

  it("puts a player with no team on the inviting team", async () => {
    await expect(accept()).resolves.toEqual({ success: true });

    expect(mutated("insert_tournament_team_roster_one")).toBe(true);
    expect(mutated("delete_tournament_team_invites_by_pk")).toBe(true);
  });

  it("refuses a player already on another team, and keeps the invite", async () => {
    seat = [{ tournament_team_id: "current-team" }];

    await expect(accept()).rejects.toThrow(/already on a team/);

    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("explains a seat taken by an accept racing this one", async () => {
    hasura.mutation.mockRejectedValueOnce(
      new Error(
        'Uniqueness violation. duplicate key value violates unique constraint "tournament_roster_pkey"',
      ),
    );

    await expect(accept()).rejects.toThrow(/already on a team/);
    expect(mutated("delete_tournament_team_invites_by_pk")).toBe(false);
  });

  it("clears the invite of a player already on the inviting team", async () => {
    seat = [{ tournament_team_id: "inviting-team" }];

    await expect(accept()).resolves.toEqual({ success: true });

    expect(mutated("insert_tournament_team_roster_one")).toBe(false);
    expect(mutated("delete_tournament_team_invites_by_pk")).toBe(true);
  });

  it("puts a player on a team-backed entry's team and lineup in one request", async () => {
    backedByTeam();

    await expect(accept()).resolves.toEqual({ success: true });

    const [joined] = hasura.mutation.mock.calls[0];
    expect(Object.keys(joined)).toEqual([
      "insert_team_roster_one",
      "insert_tournament_team_roster_one",
    ]);
    expect(joined.insert_team_roster_one.__args.object).toEqual({
      role: "Member",
      team_id: "team-1",
      player_steam_id: player.steam_id,
    });
    expect(mutated("delete_tournament_team_invites_by_pk")).toBe(true);
  });

  it("only seats a player who is already on the entry's team", async () => {
    backedByTeam();
    team = [{ joins_team: true, member: true, inviter_can_invite: true }];

    await expect(accept()).resolves.toEqual({ success: true });

    expect(mutated("insert_team_roster_one")).toBe(false);
    expect(mutated("insert_tournament_team_roster_one")).toBe(true);
  });

  it("adds a player already seated on the entry to its team", async () => {
    backedByTeam();
    seat = [{ tournament_team_id: "inviting-team" }];

    await expect(accept()).resolves.toEqual({ success: true });

    expect(mutated("insert_team_roster_one")).toBe(true);
    expect(mutated("insert_tournament_team_roster_one")).toBe(false);
  });

  it("only seats the player when the inviter can no longer invite to the team", async () => {
    backedByTeam();
    team = [{ joins_team: true, member: false, inviter_can_invite: false }];

    await expect(accept()).resolves.toEqual({ success: true });

    expect(mutated("insert_team_roster_one")).toBe(false);
    expect(mutated("insert_tournament_team_roster_one")).toBe(true);
  });

  it("only seats a stand-in, whose invite never said it joins the team", async () => {
    backedByTeam();
    team = [{ joins_team: false, member: false, inviter_can_invite: true }];

    await expect(accept()).resolves.toEqual({ success: true });

    expect(mutated("insert_team_roster_one")).toBe(false);
    expect(mutated("insert_tournament_team_roster_one")).toBe(true);
  });

  it("keeps a player off the team when the lineup cannot take them", async () => {
    backedByTeam();
    hasura.mutation.mockRejectedValueOnce("Too many players on the team");

    await expect(accept()).rejects.toBe("Too many players on the team");

    expect(hasura.mutation).toHaveBeenCalledTimes(1);
    expect(Object.keys(hasura.mutation.mock.calls[0][0])).toContain(
      "insert_team_roster_one",
    );
    expect(mutated("delete_tournament_team_invites_by_pk")).toBe(false);
  });
});

describe("InvitesController tournament team invite notifications", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const postgres = { query: jest.fn() };
  const notifications = { notifyPlayers: jest.fn() };

  const notify = async (invite: Record<string, unknown>) => {
    postgres.query.mockResolvedValue([
      {
        steam_id: "76561190000000002",
        team_name: "Ultima Ratio",
        tournament_name: "VulkanLAN 2026",
        tournament_logo: null,
        invited_by: "sniddyus",
        ...invite,
      },
    ]);
    await new InvitesController(
      logger as never,
      {} as never,
      postgres as never,
      notifications as never,
    ).tournament_team_invite_events({
      op: "INSERT",
      new: { id: "invite-1" },
    } as never);
    return notifications.notifyPlayers.mock.calls[0][1];
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("tells a player invited onto a permanent team that they join the team too", async () => {
    const sent = await notify({ joins_team: true, team_backed: true });

    expect(sent.title).toBe("Team Invite");
    expect(sent.message).toBe(
      "<b>sniddyus</b> invited you to join <b>Ultima Ratio</b> and its lineup for <b>VulkanLAN 2026</b>.",
    );
  });

  it("tells a player invited onto a tournament-only team that it is just for this tournament", async () => {
    const sent = await notify({
      team_name: "Friday Mix",
      joins_team: false,
      team_backed: false,
    });

    expect(sent.title).toBe("Tournament Invite");
    expect(sent.message).toBe(
      "<b>sniddyus</b> invited you to play for <b>Friday Mix</b> in <b>VulkanLAN 2026</b>, a team for this tournament only.",
    );
  });

  it("tells a stand-in they will not join the permanent team", async () => {
    const sent = await notify({ joins_team: false, team_backed: true });

    expect(sent.title).toBe("Tournament Invite");
    expect(sent.message).toBe(
      "<b>sniddyus</b> invited you to stand in for <b>Ultima Ratio</b> in <b>VulkanLAN 2026</b>. You won't join the team.",
    );
  });
});
