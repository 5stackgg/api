import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// In a Teams lobby `lineup` is which side a player sits on and `status` is
// whether they start there, so a Waitlist row with a lineup is that side's
// backup. These cover the two database behaviours that model depends on.
describe("draft team slots (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fixtures: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("DraftTeamSlotsTest");
    postgres = db.postgres;
    fixtures = new Fixtures(postgres, 76561193500000000n);
    await fixtures.region();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const createTeamsDraft = async (options: { innerSquad?: boolean } = {}) => {
    const team1 = await fixtures.team();
    const team2 = await fixtures.team();
    const host = await fixtures.player("host");

    const [draft] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO draft_games (host_steam_id, type, mode, status, team_1_id, team_2_id, inner_squad)
       VALUES ($1, 'Competitive', 'Teams', 'Open', $2, $3, $4) RETURNING id`,
      [
        host,
        team1.id,
        options.innerSquad ? null : team2.id,
        !!options.innerSquad,
      ],
    );

    return { id: draft.id, host, team1, team2 };
  };

  const addPlayer = async (
    draftId: string,
    steamId: string,
    status: string,
    lineup: number | null,
  ) => {
    await postgres.query(
      `INSERT INTO draft_game_players (draft_game_id, steam_id, status, lineup)
       VALUES ($1, $2, $3, $4)`,
      [draftId, steamId, status, lineup],
    );
  };

  const statusOf = async (draftId: string, steamId: string) => {
    const [row] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
      [draftId, steamId],
    );
    return row?.status;
  };

  const isOrganizerFor = async (
    draftId: string,
    steamId: string,
    actorSteamId: string,
  ) => {
    const [row] = await postgres.query<Array<{ result: boolean }>>(
      `SELECT is_draft_game_player_organizer(p, $3::json) AS result
       FROM draft_game_players p
       WHERE p.draft_game_id = $1 AND p.steam_id = $2`,
      [
        draftId,
        steamId,
        JSON.stringify({
          "x-hasura-role": "user",
          "x-hasura-user-id": actorSteamId,
        }),
      ],
    );
    return row?.result;
  };

  it("promotes a backup from the side that lost a starter", async () => {
    const draft = await createTeamsDraft();

    const starter1 = await fixtures.player("starter1");
    await addPlayer(draft.id, starter1, "Accepted", 1);
    const backup1 = await fixtures.player("backup1");
    const backup2 = await fixtures.player("backup2");
    // Side 2's backup joined first, so a side-blind promotion would take them.
    await addPlayer(draft.id, backup2, "Waitlist", 2);
    await addPlayer(draft.id, backup1, "Waitlist", 1);

    await postgres.query(
      "DELETE FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
      [draft.id, starter1],
    );

    expect(await statusOf(draft.id, backup1)).toEqual("Accepted");
    expect(await statusOf(draft.id, backup2)).toEqual("Waitlist");
  });

  it("still promotes an unsided backup when the removed player had no side", async () => {
    const draft = await createTeamsDraft();

    const spare = await fixtures.player("spare");
    await addPlayer(draft.id, spare, "Accepted", null);
    const backup = await fixtures.player("backup");
    await addPlayer(draft.id, backup, "Waitlist", 2);

    await postgres.query(
      "DELETE FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
      [draft.id, spare],
    );

    expect(await statusOf(draft.id, backup)).toEqual("Accepted");
  });

  it("lets a team owner manage their own side but not the other", async () => {
    const draft = await createTeamsDraft();

    const mine = await fixtures.player("mine");
    const theirs = await fixtures.player("theirs");
    await addPlayer(draft.id, mine, "Accepted", 1);
    await addPlayer(draft.id, theirs, "Accepted", 2);

    expect(await isOrganizerFor(draft.id, mine, draft.team1.owner)).toBe(true);
    expect(await isOrganizerFor(draft.id, theirs, draft.team1.owner)).toBe(
      false,
    );
    expect(await isOrganizerFor(draft.id, theirs, draft.team2.owner)).toBe(
      true,
    );
  });

  it("lets a team owner manage unsided players on either roster", async () => {
    const draft = await createTeamsDraft();

    const spare = await fixtures.player("spare");
    await addPlayer(draft.id, spare, "Waitlist", null);

    expect(await isOrganizerFor(draft.id, spare, draft.team1.owner)).toBe(true);
    expect(await isOrganizerFor(draft.id, spare, draft.team2.owner)).toBe(true);
  });

  it("gives an inner squad owner both sides", async () => {
    const draft = await createTeamsDraft({ innerSquad: true });

    const sideTwo = await fixtures.player("sideTwo");
    await addPlayer(draft.id, sideTwo, "Accepted", 2);

    expect(await isOrganizerFor(draft.id, sideTwo, draft.team1.owner)).toBe(
      true,
    );
    expect(await isOrganizerFor(draft.id, sideTwo, draft.team2.owner)).toBe(
      false,
    );
  });

  it("keeps an outsider off every side", async () => {
    const draft = await createTeamsDraft();

    const player = await fixtures.player("player");
    await addPlayer(draft.id, player, "Accepted", 1);
    const outsider = await fixtures.player("outsider");

    expect(await isOrganizerFor(draft.id, player, outsider)).toBe(false);
    expect(await isOrganizerFor(draft.id, player, draft.host)).toBe(true);
  });
});
