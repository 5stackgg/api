import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { NadePlaybooksService } from "./../src/nades/nade-playbooks.service";
import { NadePracticeService } from "./../src/nades/nade-practice.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A playbook is a team's execute: an ordered set of lineups with timings that a
// practice server counts down. The things that can go wrong are the things that
// go wrong with any shared, ordered, cross-referencing structure -- a book
// leaking out of a team, two steps claiming one slot, a step pointing at
// another map's smoke, and a load that reports success before the server has
// been told anything.
describe("nade playbooks (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let playbooks: NadePlaybooksService;

  beforeAll(async () => {
    db = await bootMigratedDb("NadePlaybooksTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199900000000n);
    playbooks = new NadePlaybooksService(postgres);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM nade_practice_sessions");
    await postgres.query("DELETE FROM nade_playbooks");
    await postgres.query("DELETE FROM nade_lineups");
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL WHERE reserved_by_match_id IS NOT NULL",
    );
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM servers WHERE port >= 27960");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const session = (steamId: string | null, role = "user") =>
    JSON.stringify({
      "x-hasura-role": role,
      ...(steamId ? { "x-hasura-user-id": steamId } : {}),
    });

  const asUser = (steamId: string, role = "user") =>
    ({ steam_id: steamId, role }) as never;

  async function insertLineup(
    author: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      map_name: "de_mirage",
      nade_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: -560,
      land_y: 320,
      land_z: -140,
      name: "Window from T spawn",
      visibility: "Private",
      author_steam_id: author,
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO nade_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row) as Array<string>,
    );
    return inserted.id;
  }

  async function insertPlaybook(
    owner: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      name: "A exec",
      map_name: "de_mirage",
      side: "TERRORIST",
      owner_steam_id: owner,
      visibility: "Private",
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO nade_playbooks (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
       RETURNING id::text AS id`,
      Object.values(row) as Array<string>,
    );
    return inserted.id;
  }

  async function insertStep(
    playbookId: string,
    lineupId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      playbook_id: playbookId,
      nade_lineup_id: lineupId,
      step_order: 0,
      offset_ms: 0,
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO nade_playbook_steps (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
       RETURNING id::text AS id`,
      Object.values(row) as Array<string>,
    );
    return inserted.id;
  }

  async function canView(
    playbookId: string,
    viewer: string | null,
    role = "user",
  ) {
    const [row] = await postgres.query<Array<{ ok: boolean }>>(
      `SELECT can_view_nade_playbook(p, $2::json) AS ok
         FROM nade_playbooks p WHERE p.id = $1::uuid`,
      [playbookId, session(viewer, role)],
    );
    return row.ok;
  }

  async function canEdit(
    playbookId: string,
    viewer: string | null,
    role = "user",
  ) {
    const [row] = await postgres.query<Array<{ ok: boolean }>>(
      `SELECT can_edit_nade_playbook(p, $2::json) AS ok
         FROM nade_playbooks p WHERE p.id = $1::uuid`,
      [playbookId, session(viewer, role)],
    );
    return row.ok;
  }

  async function teamMate(teamId: string, owner: string): Promise<string> {
    const [mate] = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id FROM team_roster
        WHERE team_id = $1 AND player_steam_id <> $2 LIMIT 1`,
      [teamId, owner],
    );
    return mate.player_steam_id;
  }

  async function stepRows(playbookId: string) {
    return await postgres.query<
      Array<{
        step_order: number;
        offset_ms: number;
        nade_lineup_id: string;
        assigned_steam_id: string | null;
        note: string | null;
      }>
    >(
      `SELECT step_order, offset_ms, nade_lineup_id::text AS nade_lineup_id,
              assigned_steam_id::text AS assigned_steam_id, note
         FROM nade_playbook_steps
        WHERE playbook_id = $1::uuid
        ORDER BY step_order ASC`,
      [playbookId],
    );
  }

  describe("map keying", () => {
    it("rejects a playbook on a map that does not exist", async () => {
      const owner = await fx.player();
      await expect(
        insertPlaybook(owner, { map_name: "de_notamap" }),
      ).rejects.toThrow(/Unknown map/);
    });
  });

  describe("visibility", () => {
    it("keeps a private playbook to its owner", async () => {
      const owner = await fx.player();
      const stranger = await fx.player();
      const id = await insertPlaybook(owner);

      expect(await canView(id, owner)).toBe(true);
      expect(await canView(id, stranger)).toBe(false);
      expect(await canView(id, null, "guest")).toBe(false);
    });

    it("shows a public playbook to everyone including guests", async () => {
      const owner = await fx.player();
      const stranger = await fx.player();
      const id = await insertPlaybook(owner, { visibility: "Public" });

      expect(await canView(id, owner)).toBe(true);
      expect(await canView(id, stranger)).toBe(true);
      expect(await canView(id, null, "guest")).toBe(true);
    });

    it("shows a team playbook to the team and nobody else", async () => {
      const team = await fx.team(1);
      const mate = await teamMate(team.id, team.owner);
      const stranger = await fx.player();
      const id = await insertPlaybook(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      expect(await canView(id, team.owner)).toBe(true);
      expect(await canView(id, mate)).toBe(true);
      expect(await canView(id, stranger)).toBe(false);
      expect(await canView(id, null, "guest")).toBe(false);
    });

    it("refuses Team visibility without a team", async () => {
      const owner = await fx.player();
      await expect(
        insertPlaybook(owner, { visibility: "Team" }),
      ).rejects.toThrow(/nade_playbooks_team_scope_chk/);
    });

    it("refuses publishing into a team the owner is not on", async () => {
      const team = await fx.team();
      const outsider = await fx.player();
      await expect(
        insertPlaybook(outsider, { visibility: "Team", team_id: team.id }),
      ).rejects.toThrow(/not on that team/);
    });

    it("lets a moderator see a private playbook", async () => {
      const owner = await fx.player();
      const mod = await fx.player();
      const id = await insertPlaybook(owner);

      expect(await canView(id, mod, "moderator")).toBe(true);
    });
  });

  describe("editing", () => {
    it("lets only the owner edit their own playbook", async () => {
      const owner = await fx.player();
      const stranger = await fx.player();
      const id = await insertPlaybook(owner);

      expect(await canEdit(id, owner)).toBe(true);
      expect(await canEdit(id, stranger)).toBe(false);
    });

    it("lets a team admin edit a team playbook but a plain member not", async () => {
      const team = await fx.team(2);
      const mates = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id FROM team_roster
          WHERE team_id = $1 AND player_steam_id <> $2 ORDER BY player_steam_id`,
        [team.id, team.owner],
      );
      await postgres.query(
        "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
        [team.id, mates[0].player_steam_id],
      );
      const id = await insertPlaybook(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      expect(await canEdit(id, team.owner)).toBe(true);
      expect(await canEdit(id, mates[0].player_steam_id)).toBe(true);
      expect(await canEdit(id, mates[1].player_steam_id)).toBe(false);
    });
  });

  // teams.id is ON DELETE SET NULL and the CHECK runs after the BEFORE
  // trigger, so without the demotion in tbiu_nade_playbooks a team that had
  // written an execute could not be deleted at all.
  describe("when the team goes away", () => {
    it("demotes a team playbook to private instead of blocking the delete", async () => {
      const team = await fx.team(1);
      const id = await insertPlaybook(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      await expect(
        postgres.query("DELETE FROM teams WHERE id = $1", [team.id]),
      ).resolves.toBeTruthy();

      const [row] = await postgres.query<
        Array<{ visibility: string; team_id: string | null }>
      >(
        "SELECT visibility, team_id::text AS team_id FROM nade_playbooks WHERE id = $1::uuid",
        [id],
      );
      expect(row.visibility).toBe("Private");
      expect(row.team_id).toBeNull();
    });
  });

  describe("steps", () => {
    it("refuses two steps in the same slot", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);
      const playbook = await insertPlaybook(owner);

      await insertStep(playbook, lineup, { step_order: 0 });
      await expect(
        insertStep(playbook, lineup, { step_order: 0 }),
      ).rejects.toThrow(/nade_playbook_steps_order_key/);
    });

    it("lets the same lineup be thrown twice in one execute", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);
      const playbook = await insertPlaybook(owner);

      await insertStep(playbook, lineup, { step_order: 0, offset_ms: 0 });
      await expect(
        insertStep(playbook, lineup, { step_order: 1, offset_ms: 18000 }),
      ).resolves.toBeTruthy();
    });

    // The unique constraint is DEFERRABLE for exactly this: a swap collides
    // with itself halfway through the statement, and a plain UNIQUE checks
    // row by row.
    it("allows an in-place reorder inside one transaction", async () => {
      const owner = await fx.player();
      const first = await insertLineup(owner);
      const second = await insertLineup(owner, { name: "Jungle" });
      const playbook = await insertPlaybook(owner);
      await insertStep(playbook, first, { step_order: 0 });
      await insertStep(playbook, second, { step_order: 1 });

      await runAsUser(postgres, owner, "admin", (query) =>
        query(
          `UPDATE nade_playbook_steps
              SET step_order = CASE WHEN step_order = 0 THEN 1 ELSE 0 END
            WHERE playbook_id = $1::uuid`,
          [playbook],
        ),
      );

      const steps = await stepRows(playbook);
      expect(steps.map((step) => step.nade_lineup_id)).toEqual([second, first]);
    });

    it("refuses a step whose lineup is on another map", async () => {
      const owner = await fx.player();
      const elsewhere = await insertLineup(owner, { map_name: "de_nuke" });
      const playbook = await insertPlaybook(owner);

      await expect(insertStep(playbook, elsewhere)).rejects.toThrow(
        /not on this playbook's map/,
      );
    });

    it("refuses moving a written playbook to another map", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);
      const playbook = await insertPlaybook(owner);
      await insertStep(playbook, lineup);

      await expect(
        postgres.query(
          "UPDATE nade_playbooks SET map_name = 'de_nuke' WHERE id = $1::uuid",
          [playbook],
        ),
      ).rejects.toThrow(/Remove the steps/);
    });

    it("refuses an offset outside the execute", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);
      const playbook = await insertPlaybook(owner);

      await expect(
        insertStep(playbook, lineup, { offset_ms: -1 }),
      ).rejects.toThrow(/nade_playbook_steps_offset_chk/);
    });

    it("cascades steps when the playbook or the lineup goes away", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);
      const other = await insertLineup(owner, { name: "Jungle" });
      const playbook = await insertPlaybook(owner);
      await insertStep(playbook, lineup, { step_order: 0 });
      await insertStep(playbook, other, { step_order: 1 });

      await postgres.query("DELETE FROM nade_lineups WHERE id = $1", [lineup]);
      expect((await stepRows(playbook)).length).toBe(1);

      await postgres.query("DELETE FROM nade_playbooks WHERE id = $1::uuid", [
        playbook,
      ]);
      expect((await stepRows(playbook)).length).toBe(0);
    });
  });

  describe("saving a playbook", () => {
    it("creates a book whose steps are ordered by the order they arrived", async () => {
      const owner = await fx.player();
      const thrower = await fx.player();
      const smoke = await insertLineup(owner);
      const flash = await insertLineup(owner, { name: "Flash over" });

      const { id } = await playbooks.save(asUser(owner), {
        name: "A exec",
        map_name: "de_mirage",
        side: "TERRORIST",
        steps: [
          { nade_lineup_id: smoke, offset_ms: 0, note: "CT smoke" },
          {
            nade_lineup_id: flash,
            offset_ms: 2500,
            assigned_steam_id: thrower,
          },
        ],
      });

      const steps = await stepRows(id);
      expect(steps.map((step) => step.step_order)).toEqual([0, 1]);
      expect(steps.map((step) => step.nade_lineup_id)).toEqual([smoke, flash]);
      expect(steps[0].offset_ms).toBe(0);
      expect(steps[0].note).toBe("CT smoke");
      expect(steps[1].offset_ms).toBe(2500);
      expect(steps[1].assigned_steam_id).toBe(thrower);
    });

    it("replaces the steps on update, and leaves them alone when none are sent", async () => {
      const owner = await fx.player();
      const smoke = await insertLineup(owner);
      const flash = await insertLineup(owner, { name: "Flash over" });

      const { id } = await playbooks.save(asUser(owner), {
        name: "A exec",
        map_name: "de_mirage",
        side: "TERRORIST",
        steps: [{ nade_lineup_id: smoke }, { nade_lineup_id: flash }],
      });

      await playbooks.save(asUser(owner), {
        playbook_id: id,
        name: "A exec v2",
        map_name: "de_mirage",
        side: "TERRORIST",
        steps: [{ nade_lineup_id: flash, offset_ms: 1000 }],
      });

      let steps = await stepRows(id);
      expect(steps.length).toBe(1);
      expect(steps[0].nade_lineup_id).toBe(flash);

      await playbooks.save(asUser(owner), {
        playbook_id: id,
        name: "A exec v3",
        map_name: "de_mirage",
        side: "TERRORIST",
      });

      steps = await stepRows(id);
      expect(steps.length).toBe(1);

      const [row] = await postgres.query<Array<{ name: string }>>(
        "SELECT name FROM nade_playbooks WHERE id = $1::uuid",
        [id],
      );
      expect(row.name).toBe("A exec v3");

      // An empty array is the explicit "clear the book", as opposed to the
      // omitted steps above.
      await playbooks.save(asUser(owner), {
        playbook_id: id,
        name: "A exec v4",
        map_name: "de_mirage",
        side: "TERRORIST",
        steps: [],
      });

      expect((await stepRows(id)).length).toBe(0);
    });

    // A step is a reference to somebody's lineup, so a book must not become a
    // way to read a lineup its author kept private.
    it("refuses a step pointing at a lineup the author cannot see", async () => {
      const owner = await fx.player();
      const stranger = await fx.player();
      const secret = await insertLineup(stranger);

      await expect(
        playbooks.save(asUser(owner), {
          name: "A exec",
          map_name: "de_mirage",
          side: "TERRORIST",
          steps: [{ nade_lineup_id: secret }],
        }),
      ).rejects.toThrow(/does not exist/);

      const rows = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM nade_playbooks",
      );
      expect(rows.length).toBe(0);
    });

    it("refuses a step on another map", async () => {
      const owner = await fx.player();
      const elsewhere = await insertLineup(owner, { map_name: "de_nuke" });

      await expect(
        playbooks.save(asUser(owner), {
          name: "A exec",
          map_name: "de_mirage",
          side: "TERRORIST",
          steps: [{ nade_lineup_id: elsewhere }],
        }),
      ).rejects.toThrow(/another map/);
    });

    it("refuses more steps than an execute can hold", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);

      await expect(
        playbooks.save(asUser(owner), {
          name: "A exec",
          map_name: "de_mirage",
          side: "TERRORIST",
          steps: Array.from(
            { length: NadePlaybooksService.MAX_STEPS + 1 },
            () => ({ nade_lineup_id: lineup }),
          ),
        }),
      ).rejects.toThrow(/too many steps/);
    });

    it("refuses a throw timed outside the execute", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);

      await expect(
        playbooks.save(asUser(owner), {
          name: "A exec",
          map_name: "de_mirage",
          side: "TERRORIST",
          steps: [
            {
              nade_lineup_id: lineup,
              offset_ms: NadePlaybooksService.MAX_OFFSET_MS + 1,
            },
          ],
        }),
      ).rejects.toThrow(/outside the execute/);
    });

    it("refuses an assignment to somebody who is not a player", async () => {
      const owner = await fx.player();
      const lineup = await insertLineup(owner);

      await expect(
        playbooks.save(asUser(owner), {
          name: "A exec",
          map_name: "de_mirage",
          side: "TERRORIST",
          steps: [
            { nade_lineup_id: lineup, assigned_steam_id: "76561199999999999" },
          ],
        }),
      ).rejects.toThrow(/unknown/);
    });

    it("refuses to edit somebody else's playbook", async () => {
      const owner = await fx.player();
      const stranger = await fx.player();
      const id = await insertPlaybook(owner);

      await expect(
        playbooks.save(asUser(stranger), {
          playbook_id: id,
          name: "mine now",
          map_name: "de_mirage",
          side: "TERRORIST",
        }),
      ).rejects.toThrow(/cannot edit/);
    });
  });

  describe("deleting a playbook", () => {
    it("refuses anyone who cannot edit it", async () => {
      const owner = await fx.player();
      const stranger = await fx.player();
      const id = await insertPlaybook(owner);

      await expect(playbooks.remove(asUser(stranger), id)).rejects.toThrow(
        /cannot edit/,
      );
    });

    it("clears the book out of any session running it", async () => {
      const owner = await fx.player();
      const id = await insertPlaybook(owner);
      const [inserted] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO nade_practice_sessions
           (host_steam_id, map_name, region, playbook_id)
         VALUES ($1, 'de_mirage', 'TestA', $2::uuid)
         RETURNING id::text AS id`,
        [owner, id],
      );

      await expect(playbooks.remove(asUser(owner), id)).resolves.toEqual({
        success: true,
      });

      const [row] = await postgres.query<Array<{ playbook_id: string | null }>>(
        "SELECT playbook_id::text AS playbook_id FROM nade_practice_sessions WHERE id = $1::uuid",
        [inserted.id],
      );
      expect(row.playbook_id).toBeNull();
    });
  });

  describe("loading a playbook into a session", () => {
    function makePractice(overrides: {
      matchAssistant?: Record<string, unknown>;
    }): NadePracticeService {
      return new NadePracticeService(
        new Logger("NadePlaybooksTest"),
        postgres,
        {} as never,
        {
          acquireLock: jest.fn(async (): Promise<boolean> => true),
          forget: jest.fn(async (): Promise<boolean> => true),
        } as unknown as never,
        {
          countFreeOnDemandServers: jest.fn(async (): Promise<number> => 10),
          sendNadePracticeRefresh: jest.fn(
            async (): Promise<void> => undefined,
          ),
          updateMatchStatus: jest.fn(async (): Promise<void> => undefined),
          ...(overrides.matchAssistant ?? {}),
        } as unknown as never,
        playbooks,
        {
          notifyPlayers: jest.fn(async (): Promise<number> => 0),
        } as unknown as never,
        {
          get: jest.fn(() => ({ webDomain: "https://5stack.test" })),
        } as unknown as never,
      );
    }

    async function practiceMatch(host: string): Promise<string> {
      const [map] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM maps WHERE type = 'Competitive' AND name = 'de_mirage' LIMIT 1",
      );
      const [pool] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
      );
      await postgres.query(
        "INSERT INTO _map_pool (map_pool_id, map_id) VALUES ($1, $2)",
        [pool.id, map.id],
      );
      const [options] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options
           (type, best_of, map_veto, map_pool_id, region_veto, regions,
            number_of_substitutes, knife_round, overtime, mr, tv_delay)
         VALUES ('Competitive', 1, false, $1, false, ARRAY['TestA'], $2,
                 false, false, 12, 0)
         RETURNING id`,
        [pool.id, NadePracticeService.SUBSTITUTES],
      );
      const [match] = await postgres.query<
        Array<{ id: string; lineup_1_id: string }>
      >(
        `INSERT INTO matches (match_options_id, organizer_steam_id, region, source, label)
         VALUES ($1, $2, 'TestA', 'practice', 'Nade Practice')
         RETURNING id, lineup_1_id`,
        [options.id, host],
      );
      await postgres.query(
        "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)",
        [match.lineup_1_id, host],
      );
      return match.id;
    }

    async function liveSession(host: string, matchId: string): Promise<string> {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO nade_practice_sessions
           (host_steam_id, map_name, region, match_id, status)
         VALUES ($1, 'de_mirage', 'TestA', $2::uuid, 'Ready')
         RETURNING id::text AS id`,
        [host, matchId],
      );
      return row.id;
    }

    async function loadedPlaybook(sessionId: string) {
      const [row] = await postgres.query<Array<{ playbook_id: string | null }>>(
        "SELECT playbook_id::text AS playbook_id FROM nade_practice_sessions WHERE id = $1::uuid",
        [sessionId],
      );
      return row.playbook_id;
    }

    // Same trap as the join path: the plugin holds what it last fetched, so a
    // load that reports success before the RCON lands has armed a countdown
    // the server has never heard of. Asserting the column from inside the
    // refresh is what pins the ordering.
    it("writes the playbook and only then refreshes the server", async () => {
      const host = await fx.player();
      const matchId = await practiceMatch(host);
      const sessionId = await liveSession(host, matchId);
      const lineup = await insertLineup(host);
      const playbook = await insertPlaybook(host);
      await insertStep(playbook, lineup);

      let loadedAtRefresh: string | null = null;
      const sendNadePracticeRefresh = jest.fn(async (): Promise<void> => {
        loadedAtRefresh = await loadedPlaybook(sessionId);
      });

      const practice = makePractice({
        matchAssistant: { sendNadePracticeRefresh },
      });

      await expect(
        practice.loadPlaybook(asUser(host), {
          session_id: sessionId,
          playbook_id: playbook,
        }),
      ).resolves.toEqual({ success: true });

      expect(sendNadePracticeRefresh).toHaveBeenCalledWith(matchId);
      expect(loadedAtRefresh).toBe(playbook);
    });

    it("unloads when no playbook is given", async () => {
      const host = await fx.player();
      const matchId = await practiceMatch(host);
      const sessionId = await liveSession(host, matchId);
      const playbook = await insertPlaybook(host);

      const practice = makePractice({});

      await practice.loadPlaybook(asUser(host), {
        session_id: sessionId,
        playbook_id: playbook,
      });
      expect(await loadedPlaybook(sessionId)).toBe(playbook);

      await practice.loadPlaybook(asUser(host), {
        session_id: sessionId,
        playbook_id: null,
      });
      expect(await loadedPlaybook(sessionId)).toBeNull();
    });

    it("refuses anyone but the host", async () => {
      const host = await fx.player();
      const guest = await fx.player();
      const matchId = await practiceMatch(host);
      const sessionId = await liveSession(host, matchId);
      const playbook = await insertPlaybook(guest, { visibility: "Public" });

      const practice = makePractice({});

      await expect(
        practice.loadPlaybook(asUser(guest), {
          session_id: sessionId,
          playbook_id: playbook,
        }),
      ).rejects.toThrow(/only the host/);
    });

    it("refuses a playbook the host cannot see", async () => {
      const host = await fx.player();
      const stranger = await fx.player();
      const matchId = await practiceMatch(host);
      const sessionId = await liveSession(host, matchId);
      const secret = await insertPlaybook(stranger);

      const practice = makePractice({});

      await expect(
        practice.loadPlaybook(asUser(host), {
          session_id: sessionId,
          playbook_id: secret,
        }),
      ).rejects.toThrow(/not found/);
    });

    it("refuses a playbook written for another map", async () => {
      const host = await fx.player();
      const matchId = await practiceMatch(host);
      const sessionId = await liveSession(host, matchId);
      const elsewhere = await insertPlaybook(host, { map_name: "de_nuke" });

      const practice = makePractice({});

      await expect(
        practice.loadPlaybook(asUser(host), {
          session_id: sessionId,
          playbook_id: elsewhere,
        }),
      ).rejects.toThrow(/another map/);
    });

    // The plugin runs the countdown off this payload, so it needs the timings,
    // the assignments and the geometry -- a step is very often a lineup the
    // player has never had in their own library.
    it("hands the server the ordered execute with its lineups", async () => {
      const host = await fx.player();
      const thrower = await fx.player();
      const matchId = await practiceMatch(host);
      const sessionId = await liveSession(host, matchId);
      const smoke = await insertLineup(host);
      const flash = await insertLineup(host, {
        name: "Flash over",
        nade_type: "Flash",
        land_x: -300,
      });
      const playbook = await insertPlaybook(host, { name: "A exec" });
      await insertStep(playbook, flash, {
        step_order: 1,
        offset_ms: 2500,
        assigned_steam_id: thrower,
      });
      await insertStep(playbook, smoke, { step_order: 0, offset_ms: 0 });
      await postgres.query(
        "UPDATE nade_practice_sessions SET playbook_id = $2::uuid WHERE id = $1::uuid",
        [sessionId, playbook],
      );

      const [server] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers
           (host, label, rcon_password, port, region, type, is_dedicated, enabled,
            reserved_by_match_id)
         VALUES ('127.0.0.1', 'practice-pb', '\\x00'::bytea, 27971, 'TestA', 'Ranked', true, true, $1)
         RETURNING id::text AS id`,
        [matchId],
      );

      const practice = makePractice({});
      const payload = await practice.sessionForServer(server.id);

      expect(payload?.playbook?.id).toBe(playbook);
      expect(payload?.playbook?.name).toBe("A exec");
      expect(payload?.playbook?.map_name).toBe("de_mirage");
      expect(
        payload?.playbook?.steps.map((step) => step.nade_lineup_id),
      ).toEqual([smoke, flash]);
      expect(payload?.playbook?.steps[1].offset_ms).toBe(2500);
      expect(payload?.playbook?.steps[1].assigned_steam_id).toBe(thrower);
      expect(payload?.playbook?.steps[0].assigned_steam_id).toBeNull();
      expect(payload?.playbook?.steps[0].lineup.id).toBe(smoke);
      expect(payload?.playbook?.steps[0].lineup.land_x).toBe(-560);
      expect(payload?.playbook?.steps[1].lineup.nade_type).toBe("Flash");
    });

    it("reports no playbook when none is loaded", async () => {
      const host = await fx.player();
      const matchId = await practiceMatch(host);
      await liveSession(host, matchId);

      const [server] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers
           (host, label, rcon_password, port, region, type, is_dedicated, enabled,
            reserved_by_match_id)
         VALUES ('127.0.0.1', 'practice-none', '\\x00'::bytea, 27972, 'TestA', 'Ranked', true, true, $1)
         RETURNING id::text AS id`,
        [matchId],
      );

      const practice = makePractice({});
      const payload = await practice.sessionForServer(server.id);

      expect(payload?.playbook).toBeNull();
    });
  });
});
