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
    hasura.query.mockResolvedValue({
      tournament_team_invites_by_pk: {
        steam_id: player.steam_id,
        tournament_team_id: "inviting-team",
        team: { tournament_id: "tournament-1" },
      },
    });
    hasura.mutation.mockResolvedValue({});
    postgres.query.mockImplementation(async () => seat);
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

  it("clears the invite of a player already on the inviting team", async () => {
    seat = [{ tournament_team_id: "inviting-team" }];

    await expect(accept()).resolves.toEqual({ success: true });

    expect(mutated("insert_tournament_team_roster_one")).toBe(false);
    expect(mutated("delete_tournament_team_invites_by_pk")).toBe(true);
  });
});
