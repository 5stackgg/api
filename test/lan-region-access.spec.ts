import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// tbi/tbu_match_options: below match_organizer a LAN region is only open to a
// session the api's LAN probe listed in x-hasura-lan-regions.
describe("LAN region access (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let poolId: string;

  beforeAll(async () => {
    db = await bootMigratedDb("LanRegionAccessTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199910000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "Lan", 27016);
    await seedRegionWithServer(postgres, "Lan2", 27017);
    await postgres.query(
      "UPDATE server_regions SET is_lan = true WHERE value IN ('Lan', 'Lan2')",
    );
    ({ poolId } = await fx.mapPool(1));
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const insertOptions = `INSERT INTO match_options (mr, best_of, type, map_pool_id, region_veto, regions)
     VALUES (12, 1, 'Competitive', $1, false, $2) RETURNING id`;

  const asPlayer = (
    role: string,
    lanRegions: Array<string> | undefined,
    sql: string,
    params: Array<unknown>,
  ) =>
    runAsUser(postgres, "76561198000000001", role, async (query) => {
      if (lanRegions) {
        await query("SELECT set_config('hasura.user', $1, true)", [
          JSON.stringify({
            "x-hasura-role": role,
            "x-hasura-user-id": "76561198000000001",
            "x-hasura-lan-regions": JSON.stringify(lanRegions),
          }),
        ]);
      }
      return query(sql, params);
    });

  const createOptions = (
    role: string,
    regions: Array<string>,
    lanRegions?: Array<string>,
  ) => asPlayer(role, lanRegions, insertOptions, [poolId, regions]);

  const existingOptions = async (regions: Array<string>) => {
    const [row] = await postgres.query<Array<{ id: string }>>(insertOptions, [
      poolId,
      regions,
    ]);
    return row.id;
  };

  const updateOptions = (
    role: string,
    id: string,
    set: { regions?: Array<string>; mr?: number },
    lanRegions?: Array<string>,
  ) =>
    asPlayer(
      role,
      lanRegions,
      `UPDATE match_options
       SET regions = COALESCE($2, regions), mr = COALESCE($3, mr)
       WHERE id = $1 RETURNING regions`,
      [id, set.regions ?? null, set.mr ?? null],
    );

  it("lets a user the probe placed on the LAN pick that region", async () => {
    await expect(createOptions("user", ["Lan"], ["Lan"])).resolves.toEqual([
      expect.objectContaining({ id: expect.any(String) }),
    ]);
  });

  it.each(["user", "verified_user", "streamer", "moderator"])(
    "refuses a %s off the LAN",
    async (role) => {
      await expect(createOptions(role, ["Lan"])).rejects.toThrow(
        /must be on the LAN/,
      );
    },
  );

  it("refuses a LAN region sent in another case", async () => {
    await expect(createOptions("user", ["lan"], ["Lan2"])).rejects.toThrow(
      /must be on the LAN/,
    );
  });

  it("refuses a user on a different LAN", async () => {
    await expect(createOptions("user", ["Lan"], ["Lan2"])).rejects.toThrow(
      /must be on the LAN/,
    );
  });

  it.each(["match_organizer", "tournament_organizer", "administrator"])(
    "lets a %s off the LAN pick it",
    async (role) => {
      await expect(createOptions(role, ["Lan"])).resolves.toHaveLength(1);
    },
  );

  it("leaves online regions open to a user off the LAN", async () => {
    await expect(createOptions("user", ["TestA"])).resolves.toHaveLength(1);
  });

  it("refuses a user off the LAN moving options onto a LAN", async () => {
    const id = await existingOptions(["TestA"]);
    await expect(
      updateOptions("user", id, { regions: ["Lan"] }),
    ).rejects.toThrow(/must be on the LAN/);
  });

  it("lets a user the probe placed on the LAN move options there", async () => {
    const id = await existingOptions(["TestA"]);
    await expect(
      updateOptions("user", id, { regions: ["Lan"] }, ["Lan"]),
    ).resolves.toEqual([{ regions: ["Lan"] }]);
  });

  it("refuses a user on one LAN adding the other", async () => {
    const id = await existingOptions(["Lan"]);
    await expect(
      updateOptions("user", id, { regions: ["Lan", "Lan2"] }, ["Lan"]),
    ).rejects.toThrow(/must be on the LAN/);
  });

  it("keeps LAN options editable once the user has left the LAN", async () => {
    const id = await existingOptions(["Lan", "Lan2"]);
    await expect(updateOptions("user", id, { mr: 8 })).resolves.toHaveLength(1);
    await expect(
      updateOptions("user", id, { regions: ["Lan"] }),
    ).resolves.toEqual([{ regions: ["Lan"] }]);
  });

  it("lets a match_organizer off the LAN move options there", async () => {
    const id = await existingOptions(["TestA"]);
    await expect(
      updateOptions("match_organizer", id, { regions: ["Lan"] }),
    ).resolves.toEqual([{ regions: ["Lan"] }]);
  });

  it.each(["user", "verified_user"])(
    "schedules a LAN stage's matches when a %s organizer off the LAN closes registration",
    async (role) => {
      const tournament = await tfx.createTournament([
        { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
      ]);
      const [stageOptions] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
         SELECT 8, 1, 'Wingman', id, false, false, '{Lan}'
         FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      );
      await postgres.query(
        "UPDATE tournament_stages SET match_options_id = $1 WHERE id = $2",
        [stageOptions.id, tournament.stageIds[0]],
      );
      await tfx.setStatus(
        tournament.id,
        tournament.organizer,
        "RegistrationOpen",
      );
      for (let i = 0; i < 4; i++) {
        await tfx.registerTeam(tournament.id, await fx.team(1));
      }

      await runAsUser(postgres, tournament.organizer, role, (query) =>
        query(
          "UPDATE tournaments SET status = 'RegistrationClosed' WHERE id = $1",
          [tournament.id],
        ),
      );

      const scheduled = await postgres.query<Array<{ regions: Array<string> }>>(
        `SELECT mo.regions FROM tournament_brackets tb
         INNER JOIN matches m ON m.id = tb.match_id
         INNER JOIN match_options mo ON mo.id = m.match_options_id
         WHERE tb.tournament_stage_id = $1`,
        [tournament.stageIds[0]],
      );
      expect(scheduled.length).toBeGreaterThan(0);
      for (const match of scheduled) {
        expect(match.regions).toEqual(["Lan"]);
      }
    },
  );

  describe("when no online region has servers", () => {
    const player = "76561198000000001";

    beforeAll(async () => {
      await postgres.query(
        `INSERT INTO players (steam_id, name, role) VALUES ($1, 'Player', 'user')
         ON CONFLICT DO NOTHING`,
        [player],
      );
    });

    beforeEach(async () => {
      await postgres.query(
        "DELETE FROM matches WHERE organizer_steam_id = $1",
        [player],
      );
      await postgres.query(
        "UPDATE servers SET enabled = false WHERE region = 'TestA'",
      );
    });

    afterEach(async () => {
      await postgres.query(
        "UPDATE servers SET enabled = true WHERE region = 'TestA'",
      );
    });

    const createMatch = async (role: string, lanRegions?: Array<string>) => {
      const [options] = (await asPlayer(
        role,
        lanRegions,
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, region_veto, regions)
         VALUES (12, 1, 'Competitive', $1, true, '{TestA}') RETURNING id`,
        [poolId],
      )) as Array<{ id: string }>;
      await asPlayer(
        role,
        lanRegions,
        "INSERT INTO matches (match_options_id, organizer_steam_id) VALUES ($1, $2)",
        [options.id, player],
      );
      const [row] = await postgres.query<Array<{ regions: Array<string> }>>(
        "SELECT regions FROM match_options WHERE id = $1",
        [options.id],
      );
      return [...row.regions].sort();
    };

    it("falls a user's match back to the LAN the probe placed them on", async () => {
      await expect(createMatch("user", ["Lan"])).resolves.toEqual(["Lan"]);
    });

    it("falls a match_organizer's match back to every LAN", async () => {
      await expect(createMatch("match_organizer")).resolves.toEqual([
        "Lan",
        "Lan2",
      ]);
    });

    it("gives a user off the LAN no LAN to fall back to", async () => {
      await expect(createMatch("user")).rejects.toThrow(
        /No regions with attached servers/,
      );
    });
  });

  describe("team scrim regions", () => {
    const saveListing = (
      role: string,
      teamId: string,
      regions: Array<string>,
      lanRegions?: Array<string>,
    ) =>
      asPlayer(
        role,
        lanRegions,
        `INSERT INTO team_scrim_settings (team_id, regions, notes)
         VALUES ($1, $2, 'saved')
         ON CONFLICT (team_id) DO UPDATE
         SET regions = EXCLUDED.regions, notes = EXCLUDED.notes
         RETURNING regions`,
        [teamId, regions],
      );

    const listedTeam = async (regions: Array<string>) => {
      const team = await fx.team();
      await postgres.query(
        "INSERT INTO team_scrim_settings (team_id, regions) VALUES ($1, $2)",
        [team.id, regions],
      );
      return team.id;
    };

    it("refuses a manager off the LAN listing a LAN region", async () => {
      const team = await fx.team();
      await expect(saveListing("user", team.id, ["Lan"])).rejects.toThrow(
        /must be on the LAN/,
      );
    });

    it("lets a manager the probe placed on the LAN list it", async () => {
      const team = await fx.team();
      await expect(
        saveListing("user", team.id, ["Lan"], ["Lan"]),
      ).resolves.toEqual([{ regions: ["Lan"] }]);
    });

    it("keeps a listed LAN region when a manager off the LAN saves again", async () => {
      const teamId = await listedTeam(["Lan"]);
      await expect(saveListing("user", teamId, ["Lan"])).resolves.toEqual([
        { regions: ["Lan"] },
      ]);
    });

    it("refuses a manager off the LAN adding another LAN region", async () => {
      const teamId = await listedTeam(["Lan"]);
      await expect(
        saveListing("user", teamId, ["Lan", "Lan2"]),
      ).rejects.toThrow(/must be on the LAN/);
    });

    it("lets a match_organizer off the LAN list it", async () => {
      const team = await fx.team();
      await expect(
        saveListing("match_organizer", team.id, ["Lan"]),
      ).resolves.toEqual([{ regions: ["Lan"] }]);
    });
  });

  describe("a match's own region and server", () => {
    const matchOn = async (regions: Array<string>, region: string) => {
      const [options] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, region_veto, regions)
         VALUES (12, 1, 'Competitive', $1, false, $2) RETURNING id`,
        [poolId, regions],
      );
      const [match] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO matches (match_options_id, region) VALUES ($1, $2) RETURNING id",
        [options.id, region],
      );
      return match.id;
    };

    const moveMatch = (
      id: string,
      set: { region?: string; serverRegion?: string },
      lanRegions?: Array<string>,
    ) =>
      asPlayer(
        "user",
        lanRegions,
        `UPDATE matches
         SET region = COALESCE($2, region),
             server_id = COALESCE(
               (SELECT id FROM servers WHERE region = $3 LIMIT 1),
               server_id
             )
         WHERE id = $1 RETURNING region`,
        [id, set.region ?? null, set.serverRegion ?? null],
      );

    it("refuses an organizer off the LAN moving their match onto a LAN", async () => {
      const id = await matchOn(["TestA"], "TestA");
      await expect(moveMatch(id, { region: "Lan" })).rejects.toThrow(
        /must be on the LAN/,
      );
    });

    it("refuses an organizer off the LAN putting their match on a LAN server", async () => {
      const id = await matchOn(["TestA"], "TestA");
      await expect(moveMatch(id, { serverRegion: "Lan" })).rejects.toThrow(
        /must be on the LAN/,
      );
    });

    it("lets a user the probe placed on the LAN move their match there", async () => {
      const id = await matchOn(["TestA"], "TestA");
      await expect(moveMatch(id, { region: "Lan" }, ["Lan"])).resolves.toEqual([
        { region: "Lan" },
      ]);
    });

    it("lets an organizer off the LAN pick another of the match's own regions", async () => {
      const id = await matchOn(["Lan", "Lan2"], "Lan");
      await expect(moveMatch(id, { region: "Lan2" })).resolves.toEqual([
        { region: "Lan2" },
      ]);
    });
  });

  describe("lobby regions", () => {
    const host = "76561198000000001";

    beforeAll(async () => {
      await postgres.query(
        `INSERT INTO players (steam_id, name, role) VALUES ($1, 'Player', 'user')
         ON CONFLICT DO NOTHING`,
        [host],
      );
    });

    beforeEach(async () => {
      await postgres.query("DELETE FROM draft_games WHERE host_steam_id = $1", [
        host,
      ]);
    });

    const lobby = async (regions: Array<string>) => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO draft_games (host_steam_id, type, regions)
         VALUES ($1, 'Wingman', $2) RETURNING id`,
        [host, regions],
      );
      return row.id;
    };

    const setRegions = (
      id: string,
      regions: Array<string>,
      lanRegions?: Array<string>,
    ) =>
      asPlayer(
        "user",
        lanRegions,
        "UPDATE draft_games SET regions = $2 WHERE id = $1 RETURNING regions",
        [id, regions],
      );

    it("refuses a host off the LAN opening a lobby on a LAN", async () => {
      await expect(
        asPlayer(
          "user",
          undefined,
          `INSERT INTO draft_games (host_steam_id, type, regions)
           VALUES ($1, 'Wingman', '{Lan}')`,
          [host],
        ),
      ).rejects.toThrow(/must be on the LAN/);
    });

    it("refuses a host off the LAN moving a lobby onto a LAN", async () => {
      const id = await lobby(["TestA"]);
      await expect(setRegions(id, ["Lan"])).rejects.toThrow(
        /must be on the LAN/,
      );
    });

    it("lets a host the probe placed on the LAN move a lobby there", async () => {
      const id = await lobby(["TestA"]);
      await expect(setRegions(id, ["Lan"], ["Lan"])).resolves.toEqual([
        { regions: ["Lan"] },
      ]);
    });

    it("keeps a LAN lobby's region when a host off the LAN saves it again", async () => {
      const id = await lobby(["Lan"]);
      await expect(setRegions(id, ["Lan"])).resolves.toEqual([
        { regions: ["Lan"] },
      ]);
    });
  });

  it("leaves the api's own inserts alone", async () => {
    await expect(
      postgres.query(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, region_veto, regions)
         VALUES (12, 1, 'Competitive', $1, false, $2) RETURNING id`,
        [poolId, ["Lan"]],
      ),
    ).resolves.toHaveLength(1);
  });
});
