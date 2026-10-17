import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { StageSpec, TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A stage whose options are in Admin match mode skips auto-scheduling even with
// Auto Start on. Brackets are only scheduled when their teams change, so once
// the draw had placed the teams, switching the stage to Auto (or turning Auto
// Start on) left every bracket holding both teams and no match.
describe("tournament brackets waiting on an organizer (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  type Tournament = { id: string; organizer: string; stageIds: Array<string> };

  const ROUND_ROBIN: Array<StageSpec> = [
    { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 },
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentManualSchedulingTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199910000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const asOrganizer = (t: Tournament, sql: string, params: Array<unknown>) =>
    runAsUser(postgres, t.organizer, "admin", (query) => query(sql, params));

  const giveStageOwnOptions = async (
    t: Tournament,
    matchMode: string,
  ): Promise<string> => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `SELECT clone_match_options(match_options_id) AS id
         FROM tournaments WHERE id = $1`,
      [t.id],
    );
    await postgres.query(
      "UPDATE match_options SET match_mode = $2 WHERE id = $1",
      [row.id, matchMode],
    );
    await asOrganizer(
      t,
      "UPDATE tournament_stages SET match_options_id = $2 WHERE id = $1",
      [t.stageIds[0], row.id],
    );
    return row.id;
  };

  const draw = async (
    t: Tournament,
    teamCount: number,
    status = "Live",
  ): Promise<void> => {
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < teamCount; i++) {
      await tfx.registerTeam(t.id, await fx.team(1));
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
    if (status === "Live") {
      await tfx.setStatus(t.id, t.organizer, "Live");
    }
  };

  const roundsWithMatches = async (stageId: string) =>
    (await tfx.getBrackets(stageId))
      .filter((bracket) => bracket.match_id)
      .map((bracket) => bracket.round);

  // An admin-mode round robin, drawn and Live, with no match anywhere.
  const stuckRoundRobin = async () => {
    const t = await tfx.createTournament(ROUND_ROBIN);
    const optionsId = await giveStageOwnOptions(t, "admin");
    await draw(t, 4);

    const brackets = await tfx.getBrackets(t.stageIds[0]);
    expect(
      brackets.filter(
        (bracket) =>
          bracket.round === 1 &&
          bracket.tournament_team_id_1 &&
          bracket.tournament_team_id_2,
      ),
    ).toHaveLength(2);
    expect(brackets.every((bracket) => bracket.match_id === null)).toBe(true);

    return { ...t, optionsId };
  };

  describe("switching a stage to auto match mode", () => {
    it("starts the round that is ready and leaves the later rounds waiting", async () => {
      const t = await stuckRoundRobin();

      await asOrganizer(
        t,
        "UPDATE match_options SET match_mode = 'auto' WHERE id = $1",
        [t.optionsId],
      );

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
    });

    it("lets the stage play on by itself afterwards", async () => {
      const t = await stuckRoundRobin();
      await asOrganizer(
        t,
        "UPDATE match_options SET match_mode = 'auto' WHERE id = $1",
        [t.optionsId],
      );

      await tfx.playRound(t.stageIds[0], 1);

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1, 2, 2]);
    });

    it("starts nothing while the tournament is paused", async () => {
      const t = await stuckRoundRobin();
      await tfx.setStatus(t.id, t.organizer, "Paused");

      await asOrganizer(
        t,
        "UPDATE match_options SET match_mode = 'auto' WHERE id = $1",
        [t.optionsId],
      );

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([]);
    });
  });

  describe("turning Auto Start on", () => {
    const withoutAutoStart = async () => {
      const t = await tfx.createTournament(ROUND_ROBIN);
      await postgres.query(
        "UPDATE tournaments SET auto_start = false WHERE id = $1",
        [t.id],
      );
      await draw(t, 4);
      expect(await roundsWithMatches(t.stageIds[0])).toEqual([]);
      return t;
    };

    it("starts the round that is ready and leaves the later rounds waiting", async () => {
      const t = await withoutAutoStart();

      await asOrganizer(
        t,
        "UPDATE tournaments SET auto_start = true WHERE id = $1",
        [t.id],
      );

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
    });

    it("leaves a bracket with its own later time to the scheduled job", async () => {
      const t = await withoutAutoStart();
      const [later] = (await tfx.getBrackets(t.stageIds[0])).filter(
        (bracket) => bracket.round === 1,
      );
      await postgres.query(
        "UPDATE tournament_brackets SET scheduled_at = now() + interval '3 days' WHERE id = $1",
        [later.id],
      );

      await asOrganizer(
        t,
        "UPDATE tournaments SET auto_start = true WHERE id = $1",
        [t.id],
      );

      const round1 = (await tfx.getBrackets(t.stageIds[0])).filter(
        (bracket) => bracket.round === 1,
      );
      expect(round1.find((bracket) => bracket.id === later.id)?.match_id).toBe(
        null,
      );
      expect(round1.filter((bracket) => bracket.match_id)).toHaveLength(1);
    });

    it("parks the round as Scheduled when the tournament has not started yet", async () => {
      const t = await tfx.createTournament(ROUND_ROBIN);
      await postgres.query(
        "UPDATE tournaments SET auto_start = false WHERE id = $1",
        [t.id],
      );
      await draw(t, 4, "RegistrationClosed");

      await asOrganizer(
        t,
        "UPDATE tournaments SET auto_start = true WHERE id = $1",
        [t.id],
      );

      const statuses = await postgres.query<Array<{ status: string }>>(
        `SELECT m.status
           FROM matches m
           JOIN tournament_brackets tb ON tb.match_id = m.id
          WHERE tb.tournament_stage_id = $1`,
        [t.stageIds[0]],
      );
      expect(statuses.map((match) => match.status)).toEqual([
        "Scheduled",
        "Scheduled",
      ]);
    });
  });

  // A round robin seeds every round up front, so a later round already holds
  // both teams while the earlier ones are being played.
  it("a resumed round robin does not start rounds whose teams are still playing", async () => {
    const t = await tfx.launch(ROUND_ROBIN, 4);
    expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);

    await tfx.setStatus(t.id, t.organizer, "Paused");
    await tfx.setStatus(t.id, t.organizer, "Live");

    expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
  });

  describe("scheduling a bracket", () => {
    it("starts it at once when its time is now", async () => {
      const t = await stuckRoundRobin();
      const [bracket] = await tfx.getBrackets(t.stageIds[0]);

      await asOrganizer(
        t,
        "UPDATE tournament_brackets SET scheduled_at = now() WHERE id = $1",
        [bracket.id],
      );

      const [row] = await postgres.query<Array<{ status: string }>>(
        `SELECT m.status
           FROM tournament_brackets tb
           JOIN matches m ON m.id = tb.match_id
          WHERE tb.id = $1`,
        [bracket.id],
      );
      expect(row?.status).toBe("WaitingForCheckIn");
    });

    it("leaves it for later when its time is hours away", async () => {
      const t = await stuckRoundRobin();
      const [bracket] = await tfx.getBrackets(t.stageIds[0]);

      await asOrganizer(
        t,
        "UPDATE tournament_brackets SET scheduled_at = now() + interval '3 hours' WHERE id = $1",
        [bracket.id],
      );

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([]);
    });
  });

  // create_tournaments_role defaults to user, and tbi_match caps how many
  // pending matches a user may organize. Tournament matches are created in the
  // owner's name, so the second one in a statement used to hit that cap.
  describe("an owner with the user role", () => {
    const asUser = (t: Tournament, sql: string, params: Array<unknown>) =>
      runAsUser(postgres, t.organizer, "user", (query) => query(sql, params));

    it("can turn Auto Start on and get every ready match", async () => {
      const t = await tfx.createTournament(ROUND_ROBIN);
      await postgres.query(
        "UPDATE tournaments SET auto_start = false WHERE id = $1",
        [t.id],
      );
      await draw(t, 4);

      await asUser(t, "UPDATE tournaments SET auto_start = true WHERE id = $1", [
        t.id,
      ]);

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
    });

    it("can switch a stage to auto match mode", async () => {
      const t = await stuckRoundRobin();

      await asUser(
        t,
        "UPDATE match_options SET match_mode = 'auto' WHERE id = $1",
        [t.optionsId],
      );

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
    });

    it("can schedule one match ASAP after another", async () => {
      const t = await stuckRoundRobin();
      const round1 = (await tfx.getBrackets(t.stageIds[0])).filter(
        (bracket) => bracket.round === 1,
      );

      for (const bracket of round1) {
        await asUser(
          t,
          "UPDATE tournament_brackets SET scheduled_at = now() WHERE id = $1",
          [bracket.id],
        );
      }

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
    });

    it("can resume a paused tournament whose next round filled up meanwhile", async () => {
      const t = await tfx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 8, maxTeams: 8 }],
        8,
      );
      await tfx.setStatus(t.id, t.organizer, "Paused");
      await tfx.playRound(t.stageIds[0], 1);
      expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1, 1, 1]);

      await asUser(t, "UPDATE tournaments SET status = 'Live' WHERE id = $1", [
        t.id,
      ]);

      expect(await roundsWithMatches(t.stageIds[0])).toEqual([
        1, 1, 1, 1, 2, 2,
      ]);
    });
  });

  // Each side used to read the other's uncommitted state: the draw saw the old
  // admin mode, the switch saw RegistrationOpen, and neither scheduled a match.
  it("a switch to auto racing the close of registration still schedules the draw", async () => {
    const t = await tfx.createTournament(ROUND_ROBIN);
    const optionsId = await giveStageOwnOptions(t, "admin");
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(t.id, await fx.team(1));
    }

    const client = await (
      postgres as unknown as {
        pool: {
          connect(): Promise<{
            query(sql: string, params?: unknown[]): Promise<unknown>;
            release(): void;
          }>;
        };
      }
    ).pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('hasura.user', $1, true)", [
        JSON.stringify({
          "x-hasura-role": "admin",
          "x-hasura-user-id": t.organizer,
        }),
      ]);
      await client.query(
        "UPDATE match_options SET match_mode = 'auto' WHERE id = $1",
        [optionsId],
      );

      const close = tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.query("COMMIT");
      await close;
    } finally {
      await client.query("SELECT set_config('hasura.user', '{}', false)");
      client.release();
    }

    expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
  });

  // The switch's sync locks the cloned options of the matches already drawn,
  // and a reopen of registration holds the tournament while it deletes them.
  // Taking the tournament after the sync made each wait on the other.
  it("a switch to auto racing a reopen of registration does not deadlock", async () => {
    const t = await tfx.createTournament([
      { type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    const optionsId = await giveStageOwnOptions(t, "auto");
    await draw(t, 4, "RegistrationClosed");
    expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
    await asOrganizer(
      t,
      "UPDATE match_options SET match_mode = 'admin' WHERE id = $1",
      [optionsId],
    );

    type Client = {
      query(sql: string, params?: unknown[]): Promise<unknown>;
      release(): void;
    };
    const connect = async (): Promise<Client> => {
      const client = await (
        postgres as unknown as { pool: { connect(): Promise<Client> } }
      ).pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT set_config('hasura.user', $1, true)", [
        JSON.stringify({
          "x-hasura-role": "admin",
          "x-hasura-user-id": t.organizer,
        }),
      ]);
      return client;
    };
    const settle = (client: Client, statement: Promise<unknown>) =>
      statement.then(
        async () => {
          await client.query("COMMIT");
          return "ok";
        },
        async (error: { message: string }) => {
          await client.query("ROLLBACK");
          return error.message;
        },
      );

    const reopen = await connect();
    const toggle = await connect();
    try {
      await reopen.query(
        "SELECT 1 FROM tournaments WHERE id = $1 FOR NO KEY UPDATE",
        [t.id],
      );
      const switched = settle(
        toggle,
        toggle.query(
          "UPDATE match_options SET match_mode = 'auto' WHERE id = $1",
          [optionsId],
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const reopened = settle(
        reopen,
        reopen.query(
          "UPDATE tournaments SET status = 'RegistrationOpen' WHERE id = $1",
          [t.id],
        ),
      );

      expect(await Promise.all([switched, reopened])).toEqual(["ok", "ok"]);
    } finally {
      for (const client of [reopen, toggle]) {
        await client.query("SELECT set_config('hasura.user', '{}', false)");
        client.release();
      }
    }
  });

  describe("a drawn stage's own options", () => {
    const bracketIds = async (stageId: string) =>
      (await tfx.getBrackets(stageId)).map((bracket) => bracket.id).sort();

    it("can be handed back while the stage has no match, without redrawing it, and the stage starts", async () => {
      const t = await stuckRoundRobin();
      const before = await bracketIds(t.stageIds[0]);

      await asOrganizer(
        t,
        "UPDATE tournament_stages SET match_options_id = NULL WHERE id = $1",
        [t.stageIds[0]],
      );

      expect(await bracketIds(t.stageIds[0])).toEqual(before);
      expect(await roundsWithMatches(t.stageIds[0])).toEqual([1, 1]);
    });

    it("can be taken while the stage has no match, without redrawing it", async () => {
      const t = await tfx.createTournament(ROUND_ROBIN);
      await postgres.query(
        "UPDATE tournaments SET auto_start = false WHERE id = $1",
        [t.id],
      );
      await draw(t, 4);
      const before = await bracketIds(t.stageIds[0]);

      const [row] = await postgres.query<Array<{ id: string }>>(
        `SELECT clone_match_options(match_options_id) AS id
           FROM tournaments WHERE id = $1`,
        [t.id],
      );
      await asOrganizer(
        t,
        "UPDATE tournament_stages SET match_options_id = $2 WHERE id = $1",
        [t.stageIds[0], row.id],
      );

      expect(await bracketIds(t.stageIds[0])).toEqual(before);
    });

    it("refuses options of the same match type with other maps", async () => {
      const t = await stuckRoundRobin();
      const { poolId } = await fx.mapPool(3, { mapType: "Wingman" });
      const [row] = await postgres.query<Array<{ id: string }>>(
        `SELECT clone_match_options(match_options_id) AS id
           FROM tournaments WHERE id = $1`,
        [t.id],
      );
      await postgres.query(
        "UPDATE match_options SET map_pool_id = $2 WHERE id = $1",
        [row.id, poolId],
      );

      await expect(
        asOrganizer(
          t,
          "UPDATE tournament_stages SET match_options_id = $2 WHERE id = $1",
          [t.stageIds[0], row.id],
        ),
      ).rejects.toThrow(/match type or map pool/);
    });

    it("refuses options of another match type on the same maps", async () => {
      const t = await stuckRoundRobin();
      const [row] = await postgres.query<Array<{ id: string }>>(
        `SELECT clone_match_options(match_options_id) AS id
           FROM tournaments WHERE id = $1`,
        [t.id],
      );
      await postgres.query(
        "UPDATE match_options SET type = 'Competitive' WHERE id = $1",
        [row.id],
      );

      await expect(
        asOrganizer(
          t,
          "UPDATE tournament_stages SET match_options_id = $2 WHERE id = $1",
          [t.stageIds[0], row.id],
        ),
      ).rejects.toThrow(/match type or map pool/);
    });

    it("stay attached once the stage has a match", async () => {
      const t = await tfx.launch(ROUND_ROBIN, 4);
      const [row] = await postgres.query<Array<{ id: string }>>(
        `SELECT clone_match_options(match_options_id) AS id
           FROM tournaments WHERE id = $1`,
        [t.id],
      );

      await expect(
        asOrganizer(
          t,
          "UPDATE tournament_stages SET match_options_id = $2 WHERE id = $1",
          [t.stageIds[0], row.id],
        ),
      ).rejects.toThrow(/already started/);
    });
  });
});
