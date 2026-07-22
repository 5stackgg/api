import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// A Teams draft lobby creates its match with a team_id on each lineup, which
// makes tai_match seed the lineup off the team roster and throw away the slots
// the host assigned in the lobby. DraftMatchService reconciles the lineup back
// to the draft assignment; these cover the database guards that reconcile has
// to pass through.
describe("draft team lineups (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fixtures: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("DraftTeamLineupsTest");
    postgres = db.postgres;
    fixtures = new Fixtures(postgres, 76561193400000000n);
    await fixtures.region();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const rosteredTeam = async () => {
    const { id, owner } = await fixtures.team();
    const starters = [owner];
    const substitutes: Array<string> = [];

    for (let i = 0; i < 4; i++) {
      const mate = await fixtures.player();
      starters.push(mate);
      await runAsUser(postgres, owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
          [id, mate],
        ),
      );
    }

    for (let i = 0; i < 2; i++) {
      const sub = await fixtures.player();
      substitutes.push(sub);
      await runAsUser(postgres, owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Substitute')",
          [id, sub],
        ),
      );
    }

    return { id, captain: owner, starters, substitutes };
  };

  const createTeamMatch = async (
    team1Id: string,
    team2Id: string,
    substitutes: number,
  ) => {
    const optionsId = await fixtures.matchOptions({ substitutes });
    const [lineup1] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups (team_id) VALUES ($1) RETURNING id",
      [team1Id],
    );
    const [lineup2] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups (team_id) VALUES ($1) RETURNING id",
      [team2Id],
    );
    const [match] = await postgres.query<Array<{ id: string; status: string }>>(
      `INSERT INTO matches (match_options_id, lineup_1_id, lineup_2_id)
       VALUES ($1, $2, $3) RETURNING id, status`,
      [optionsId, lineup1.id, lineup2.id],
    );
    return { match, lineup1: lineup1.id, lineup2: lineup2.id };
  };

  const lineupSteamIds = async (lineupId: string) => {
    const rows = await postgres.query<Array<{ steam_id: string }>>(
      "SELECT steam_id FROM match_lineup_players WHERE match_lineup_id = $1",
      [lineupId],
    );
    return rows.map((row) => row.steam_id).sort();
  };

  const reconcile = async (lineupId: string, assigned: Array<string>) => {
    await postgres.query(
      "DELETE FROM match_lineup_players WHERE match_lineup_id = $1 AND NOT (steam_id = ANY($2::bigint[]))",
      [lineupId, assigned],
    );
    const existing = await lineupSteamIds(lineupId);
    for (const steamId of assigned.filter((id) => !existing.includes(id))) {
      await postgres.query(
        "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)",
        [lineupId, steamId],
      );
    }
  };

  it("seeds the lineup off the team roster, ignoring the draft assignment", async () => {
    const team1 = await rosteredTeam();
    const team2 = await rosteredTeam();
    const { lineup1 } = await createTeamMatch(team1.id, team2.id, 0);

    expect(await lineupSteamIds(lineup1)).toEqual(team1.starters.sort());
  });

  it("takes substitutes once the match allows them", async () => {
    const team1 = await rosteredTeam();
    const team2 = await rosteredTeam();
    const { lineup1 } = await createTeamMatch(team1.id, team2.id, 2);

    expect(await lineupSteamIds(lineup1)).toEqual(
      [...team1.starters, ...team1.substitutes].sort(),
    );
  });

  it("lets the draft assignment replace the seeded roster while picking players", async () => {
    const team1 = await rosteredTeam();
    const team2 = await rosteredTeam();
    const { match, lineup1 } = await createTeamMatch(team1.id, team2.id, 2);

    expect(match.status).toEqual("PickingPlayers");

    // Host benched two starters in the lobby and slotted both substitutes in.
    const assigned = [
      team1.captain,
      ...team1.starters.slice(1, 3),
      ...team1.substitutes,
    ];

    await reconcile(lineup1, assigned);

    expect(await lineupSteamIds(lineup1)).toEqual(assigned.sort());
  });

  it("keeps the captain on a player the draft assigned", async () => {
    const team1 = await rosteredTeam();
    const team2 = await rosteredTeam();
    const { lineup1 } = await createTeamMatch(team1.id, team2.id, 2);

    // The team captain is benched, so the seeded captain flag has to move.
    const assigned = [...team1.starters.slice(1), ...team1.substitutes];

    await reconcile(lineup1, assigned);
    await postgres.query(
      "UPDATE match_lineup_players SET captain = true WHERE match_lineup_id = $1 AND steam_id = $2",
      [lineup1, assigned[0]],
    );

    const captains = await postgres.query<Array<{ steam_id: string }>>(
      "SELECT steam_id FROM match_lineup_players WHERE match_lineup_id = $1 AND captain = true",
      [lineup1],
    );

    expect(captains.map((row) => row.steam_id)).toEqual([assigned[0]]);
  });

  it("moves a player across lineups when both are pruned first", async () => {
    const team1 = await rosteredTeam();
    const team2 = await rosteredTeam();
    const { lineup1, lineup2 } = await createTeamMatch(team1.id, team2.id, 2);

    // Inner-squad style split: a team 1 starter is assigned to the other side.
    const crossed = team1.starters[4];
    const side1 = team1.starters.slice(0, 4);
    const side2 = [...team2.starters, crossed];

    await reconcile(lineup1, side1);
    await reconcile(lineup2, side2);

    expect(await lineupSteamIds(lineup1)).toEqual(side1.sort());
    expect(await lineupSteamIds(lineup2)).toEqual(side2.sort());
  });
});
