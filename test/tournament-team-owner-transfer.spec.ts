import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// tournament_teams.owner_steam_id is copied from the team at registration and
// carries the entry's manage rights, check-in reminders and the one team per
// owner rule. A team ownership transfer has to move it too, or the former
// owner keeps all of that for a team they no longer own.
describe("tournament entry owner follows a team ownership transfer (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentTeamOwnerTransferTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199620000000n);
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

  const openTournament = async ({
    registrationType = "teams",
    substitutes = 0,
  } = {}) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestA}', $1
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      [substitutes],
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status, registration_type)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', $4) RETURNING id`,
      [fx.nextName("cup"), organizer, options.id, registrationType],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
    );
    await setStatus(tournament.id, organizer, "RegistrationOpen");
    return { id: tournament.id, organizer };
  };

  const setStatus = (
    tournamentId: string,
    actor: string,
    status: string,
    role = "admin",
  ) =>
    runAsUser(postgres, actor, role, (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );

  const register = (tournamentId: string, teamId: string, actor: string) =>
    runAsUser(postgres, actor, "user", (query) =>
      query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name)
         SELECT $1, id, name FROM teams WHERE id = $2`,
        [tournamentId, teamId],
      ),
    );

  const transfer = (teamId: string, from: string, to: string) =>
    runAsUser(postgres, from, "user", (query) =>
      query("UPDATE teams SET owner_steam_id = $2 WHERE id = $1", [teamId, to]),
    );

  const entry = async (tournamentId: string, teamId: string) => {
    const [row] = await postgres.query<
      Array<{ owner_steam_id: string; captain_steam_id: string }>
    >(
      `SELECT owner_steam_id::text, captain_steam_id::text
       FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2`,
      [tournamentId, teamId],
    );
    return row;
  };

  const heirOf = async (teamId: string, owner: string) => {
    const [row] = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id::text FROM team_roster
       WHERE team_id = $1 AND player_steam_id <> $2
       ORDER BY player_steam_id LIMIT 1`,
      [teamId, owner],
    );
    return row.player_steam_id;
  };

  it("moves the entry to the new owner and leaves the captain alone", async () => {
    const t = await openTournament();
    const team = await fx.team(1);
    const heir = await heirOf(team.id, team.owner);
    await register(t.id, team.id, team.owner);

    await transfer(team.id, team.owner, heir);

    expect(await entry(t.id, team.id)).toEqual({
      owner_steam_id: heir,
      captain_steam_id: team.owner,
    });
  });

  it("lets the former owner register another of their teams afterwards", async () => {
    const t = await openTournament();
    const team = await fx.team(1);
    const heir = await heirOf(team.id, team.owner);
    await register(t.id, team.id, team.owner);
    const [other] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [fx.nextName("academy"), team.owner],
    );

    await transfer(team.id, team.owner, heir);

    await expect(register(t.id, other.id, team.owner)).resolves.toBeDefined();
    expect((await entry(t.id, other.id)).owner_steam_id).toBe(team.owner);
  });

  it("still moves the entry when the new owner already owns another entry", async () => {
    const t = await openTournament();
    const team = await fx.team(1);
    const heir = await heirOf(team.id, team.owner);
    const [heirsTeam] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [fx.nextName("own"), heir],
    );
    await register(t.id, heirsTeam.id, heir);
    await register(t.id, team.id, team.owner);

    await transfer(team.id, team.owner, heir);

    expect((await entry(t.id, team.id)).owner_steam_id).toBe(heir);
    expect((await entry(t.id, heirsTeam.id)).owner_steam_id).toBe(heir);
  });

  const entryWithHeir = async ({ substitutes = 0 } = {}) => {
    const t = await openTournament({ registrationType: "both", substitutes });
    const team = await fx.team(2);
    const [heir, starter] = (
      await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id::text FROM team_roster
         WHERE team_id = $1 AND player_steam_id <> $2
         ORDER BY player_steam_id`,
        [team.id, team.owner],
      )
    ).map((row) => row.player_steam_id);
    const entryId = await runAsUser(
      postgres,
      team.owner,
      "user",
      async (query) => {
        const [registered] = (await query(
          `INSERT INTO tournament_teams (tournament_id, team_id, name)
           SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id`,
          [t.id, team.id],
        )) as Array<{ id: string }>;
        for (const player of [team.owner, starter]) {
          await query(
            `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
             VALUES ($1, $2, $3)`,
            [registered.id, player, t.id],
          );
        }
        return registered.id;
      },
    );
    return { t, team, entryId, heir, starter };
  };

  const joinPool = async (
    tournamentId: string,
    steamId: string,
    status = "registered",
  ) => {
    await postgres.query(
      `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
       VALUES ($1, $2)`,
      [tournamentId, steamId],
    );
    await postgres.query(
      `UPDATE tournament_free_agents SET status = $3, checked_in_at = now()
       WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, steamId, status],
    );
  };

  const entryWithPooledHeir = async (
    status: string,
    { substitutes = 0 } = {},
  ) => {
    const entry = await entryWithHeir({ substitutes });
    await joinPool(entry.t.id, entry.heir, status);
    const bystander = await fx.player();
    await joinPool(entry.t.id, bystander);
    return { ...entry, bystander };
  };

  const poolOf = (tournamentId: string) =>
    postgres.query<Array<{ player_steam_id: string; status: string }>>(
      `SELECT player_steam_id::text, status
       FROM tournament_free_agents WHERE tournament_id = $1`,
      [tournamentId],
    );

  const rosterOf = (entryId: string) =>
    postgres.query<
      Array<{ player_steam_id: string; role: string; checked_in: boolean }>
    >(
      `SELECT player_steam_id::text, role, checked_in_at IS NOT NULL AS checked_in
       FROM tournament_team_roster WHERE tournament_team_id = $1
       ORDER BY player_steam_id`,
      [entryId],
    );

  const waitForLockWaits = async (count: number) => {
    for (let attempt = 0; ; attempt++) {
      const [row] = await postgres.query<Array<{ waiting: number }>>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (row.waiting >= count) {
        return;
      }
      if (attempt > 400) {
        throw new Error(`fewer than ${count} writes waited on a lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  type Session = {
    query(sql: string, params?: Array<unknown>): Promise<unknown>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  };

  const openSession = async (
    steamId?: string,
    role?: string,
  ): Promise<Session> => {
    const client = await (
      postgres as unknown as {
        pool: {
          connect(): Promise<{
            query(sql: string, params?: Array<unknown>): Promise<unknown>;
            release(): void;
          }>;
        };
      }
    ).pool.connect();
    await client.query("BEGIN");
    if (role) {
      await client.query("SELECT set_config('hasura.user', $1, true)", [
        JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId }),
      ]);
    }
    let open = true;
    const end = async (statement: string) => {
      if (!open) {
        return;
      }
      open = false;
      try {
        await client.query(statement);
      } finally {
        await client.query("SELECT set_config('hasura.user', '{}', false)");
        client.release();
      }
    };
    return {
      query: (sql, params) => client.query(sql, params),
      commit: () => end("COMMIT"),
      rollback: () => end("ROLLBACK"),
    };
  };

  const outcome = (write: Promise<unknown>) =>
    write.then(
      () => "done",
      (error: unknown) => String(error),
    );

  const addToRoster = (
    entryId: string,
    tournamentId: string,
    steamId: string,
  ) =>
    runAsUser(postgres, steamId, "admin", (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [entryId, steamId, tournamentId],
      ),
    );

  // One entry per player: owning a team is being in the tournament, so the new
  // owner cannot also wait in its free-agent pool, where the draft and the
  // waitlist promotion would skip them forever.
  it.each(["registered", "waitlisted"])(
    "takes a %s new owner out of the tournament's free-agent pool, leaving a full roster as it is",
    async (status) => {
      const { t, team, entryId, heir, starter, bystander } =
        await entryWithPooledHeir(status);

      await transfer(team.id, team.owner, heir);

      expect((await entry(t.id, team.id)).owner_steam_id).toBe(heir);
      expect(await poolOf(t.id)).toEqual([
        { player_steam_id: bystander, status: "registered" },
      ]);
      expect(
        (await rosterOf(entryId)).map((row) => row.player_steam_id),
      ).toEqual([team.owner, starter].sort());
    },
  );

  it.each(["registered", "waitlisted"])(
    "seats a %s new owner on the entry's roster when it has room, keeping their check-in",
    async (status) => {
      const { t, team, entryId, heir, bystander } = await entryWithPooledHeir(
        status,
        { substitutes: 1 },
      );

      await transfer(team.id, team.owner, heir);

      expect((await entry(t.id, team.id)).owner_steam_id).toBe(heir);
      expect(await poolOf(t.id)).toEqual([
        { player_steam_id: bystander, status: "registered" },
      ]);
      expect(await rosterOf(entryId)).toContainEqual({
        player_steam_id: heir,
        role: "Member",
        checked_in: true,
      });
      expect(await rosterOf(entryId)).toHaveLength(3);
    },
  );

  it("seats the new owner of an entry with no team behind it as its Admin", async () => {
    const t = await openTournament({
      registrationType: "both",
      substitutes: 1,
    });
    const [founder, heir] = await fx.players(2);
    const [adHoc] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
       VALUES ($1, 'Squad', $2, $2) RETURNING id`,
      [t.id, founder],
    );
    await runAsUser(postgres, founder, "admin", (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [adHoc.id, founder, t.id],
      ),
    );
    await joinPool(t.id, heir);

    await runAsUser(postgres, t.organizer, "admin", (query) =>
      query("UPDATE tournament_teams SET owner_steam_id = $2 WHERE id = $1", [
        adHoc.id,
        heir,
      ]),
    );

    expect(await poolOf(t.id)).toEqual([]);
    expect(await rosterOf(adHoc.id)).toContainEqual({
      player_steam_id: heir,
      role: "Admin",
      checked_in: true,
    });
  });

  describe("racing the new owner's other ways into the tournament", () => {
    const rosterIds = async (entryId: string) =>
      (await rosterOf(entryId)).map((row) => row.player_steam_id);

    it("refuses a pool sign-up that waited for the transfer", async () => {
      const { t, team, heir } = await entryWithHeir();
      const transferring = await openSession(team.owner, "user");
      let signedUp: Promise<string> | undefined;
      try {
        await transferring.query(
          "UPDATE teams SET owner_steam_id = $2 WHERE id = $1",
          [team.id, heir],
        );
        signedUp = outcome(
          runAsUser(postgres, heir, "user", (query) =>
            query(
              `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
               VALUES ($1, $2)`,
              [t.id, heir],
            ),
          ),
        );
        await waitForLockWaits(1);
        await transferring.commit();
      } finally {
        await transferring.rollback();
        await signedUp;
      }

      expect(await signedUp).toMatch(/already have a team in this tournament/i);
      expect((await entry(t.id, team.id)).owner_steam_id).toBe(heir);
      expect(await poolOf(t.id)).toEqual([]);
    });

    // Not seated, though the entry has room: the transfer read the pool
    // before it waited, and seating them after the wait would hold the entry
    // lock while taking the roster key.
    it("removes a pool sign-up the transfer waited for", async () => {
      const { t, team, entryId, heir, starter } = await entryWithHeir({
        substitutes: 1,
      });
      const signingUp = await openSession(heir, "user");
      let transferred: Promise<string> | undefined;
      try {
        await signingUp.query(
          `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
           VALUES ($1, $2)`,
          [t.id, heir],
        );
        transferred = outcome(transfer(team.id, team.owner, heir));
        await waitForLockWaits(1);
        await signingUp.commit();
      } finally {
        await signingUp.rollback();
        await transferred;
      }

      expect(await transferred).toBe("done");
      expect((await entry(t.id, team.id)).owner_steam_id).toBe(heir);
      expect(await poolOf(t.id)).toEqual([]);
      expect(await rosterIds(entryId)).toEqual([team.owner, starter].sort());
    });

    // A player joining a roster takes the (tournament, player) roster key and
    // the tournament_entry lock after it. Taken the other way round here, a
    // new owner joining another roster at the same moment deadlocks with the
    // transfer.
    it("does not deadlock with their roster join on another entry", async () => {
      const { t, team, entryId, heir } = await entryWithHeir({
        substitutes: 1,
      });
      const other = await fx.team(1);
      await register(t.id, other.id, other.owner);
      const [otherEntry] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2",
        [t.id, other.id],
      );
      await joinPool(t.id, heir);

      const holder = await openSession();
      let transferred: Promise<string> | undefined;
      let joined: Promise<string> | undefined;
      try {
        await holder.query(
          `SELECT 1 FROM tournament_free_agents
           WHERE tournament_id = $1 AND player_steam_id = $2 FOR UPDATE`,
          [t.id, heir],
        );
        transferred = outcome(transfer(team.id, team.owner, heir));
        await waitForLockWaits(1);
        joined = outcome(addToRoster(otherEntry.id, t.id, heir));
        await waitForLockWaits(2);
        await holder.commit();
      } finally {
        await holder.rollback();
        await transferred;
        await joined;
      }

      expect(await transferred).toBe("done");
      expect(await joined).toMatch(/tournament_roster_pkey/);
      expect(await rosterIds(entryId)).toContain(heir);
      expect(await rosterIds(otherEntry.id)).not.toContain(heir);
      expect(await poolOf(t.id)).toEqual([]);
    });

    // The transfer holds the entry's row when it seats the owner, so a join
    // has to take that row before the roster key too.
    it("does not deadlock with their roster join on the same entry", async () => {
      const { t, team, entryId, heir } = await entryWithHeir({
        substitutes: 1,
      });
      await joinPool(t.id, heir);

      const holder = await openSession();
      let joined: Promise<string> | undefined;
      let transferred: Promise<string> | undefined;
      try {
        await holder.query(
          `SELECT pg_advisory_xact_lock(
             hashtext('tournament_entry'),
             hashtext($1::text || ':' || $2::text)
           )`,
          [t.id, heir],
        );
        joined = outcome(addToRoster(entryId, t.id, heir));
        await waitForLockWaits(1);
        transferred = outcome(transfer(team.id, team.owner, heir));
        await waitForLockWaits(2);
        await holder.commit();
      } finally {
        await holder.rollback();
        await joined;
        await transferred;
      }

      expect(await joined).toBe("done");
      expect(await transferred).toBe("done");
      expect((await entry(t.id, team.id)).owner_steam_id).toBe(heir);
      expect(
        (await rosterIds(entryId)).filter((steamId) => steamId === heir),
      ).toEqual([heir]);
      expect(await poolOf(t.id)).toEqual([]);
    });

    it("never fills the entry past its maximum beside another roster add", async () => {
      const { t, team, entryId, heir } = await entryWithHeir({
        substitutes: 1,
      });
      await joinPool(t.id, heir);
      const latecomer = await fx.player();

      const transferring = await openSession(team.owner, "user");
      let added: Promise<string> | undefined;
      try {
        await transferring.query(
          "UPDATE teams SET owner_steam_id = $2 WHERE id = $1",
          [team.id, heir],
        );
        added = outcome(addToRoster(entryId, t.id, latecomer));
        await waitForLockWaits(1);
        await transferring.commit();
      } finally {
        await transferring.rollback();
        await added;
      }

      expect(await added).toMatch(/too many players/i);
      const seated = await rosterIds(entryId);
      expect(seated).toHaveLength(3);
      expect(seated).toContain(heir);
    });
  });

  it("leaves a new owner who no longer meets the entry requirements off the roster", async () => {
    const { t, team, entryId, heir, bystander } = await entryWithPooledHeir(
      "registered",
      { substitutes: 1 },
    );
    await postgres.query("UPDATE tournaments SET max_elo = 1 WHERE id = $1", [
      t.id,
    ]);

    await transfer(team.id, team.owner, heir);

    expect((await entry(t.id, team.id)).owner_steam_id).toBe(heir);
    expect(await poolOf(t.id)).toEqual([
      { player_steam_id: bystander, status: "registered" },
    ]);
    expect(
      (await rosterOf(entryId)).map((row) => row.player_steam_id),
    ).not.toContain(heir);
  });

  // A lone free agent the draft could not make a team of is still waiting when
  // the bracket is drawn.
  it("seats a pooled new owner in the entry's drawn match once registration has closed", async () => {
    const { t, team, entryId, heir } = await entryWithHeir({ substitutes: 1 });
    for (let i = 0; i < 3; i++) {
      const other = await fx.team(1);
      await register(t.id, other.id, other.owner);
    }
    await joinPool(t.id, heir);
    await setStatus(t.id, t.organizer, "RegistrationClosed");
    expect(await poolOf(t.id)).toEqual([
      { player_steam_id: heir, status: "registered" },
    ]);

    await transfer(team.id, team.owner, heir);

    const seated = await postgres.query<Array<{ steam_id: string }>>(
      `SELECT mlp.steam_id::text
       FROM tournament_brackets tb
       INNER JOIN matches m ON m.id = tb.match_id
       INNER JOIN match_lineup_players mlp ON mlp.match_lineup_id = CASE
           WHEN tb.tournament_team_id_1 = $1 THEN m.lineup_1_id
           ELSE m.lineup_2_id
         END
       WHERE $1 IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
         AND m.status = 'Scheduled'`,
      [entryId],
    );
    expect(seated.map((row) => row.steam_id)).toContain(heir);
    expect(await poolOf(t.id)).toEqual([]);
  });

  it.each([
    ["Finished", "administrator"],
    ["Cancelled", "admin"],
  ])("keeps the owner of record in a %s tournament", async (status, role) => {
    const t = await openTournament();
    const team = await fx.team(1);
    const heir = await heirOf(team.id, team.owner);
    await register(t.id, team.id, team.owner);
    await setStatus(t.id, t.organizer, status, role);

    await transfer(team.id, team.owner, heir);

    expect((await entry(t.id, team.id)).owner_steam_id).toBe(team.owner);
  });
});
