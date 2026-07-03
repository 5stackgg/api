import { PostgresService } from "./../src/postgres/postgres.service";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the match lifecycle triggers (tbi_match / tai_match / tbu_matches /
// tau_matches / tbd+tad_matches): lineup provisioning, region resolution, map
// setup, the pending-match guard, status transition side effects (started_at /
// ended_at / cancels_at), veto redirection, server release, and delete cleanup.
describe("match lifecycle (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let seq = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchLifecycleTest");
    postgres = db.postgres;

    // Two regions so tbi_match_options doesn't collapse region_veto, and so
    // multi-region veto scenarios are reachable.
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27016);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    // Matches first (options are RESTRICTed by matches), then leftover options
    // (tad_match_options prunes custom pools), then players.
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
  });

  const nextSteam = () => (76561190000000000n + BigInt(++seq)).toString();

  const seedPlayer = async () => {
    const steam = nextSteam();
    await postgres.query(
      "INSERT INTO players (steam_id, name) VALUES ($1, $2)",
      [steam, `p${seq}`],
    );
    return steam;
  };

  // A Custom pool with exactly `size` maps: setup_match_maps only materializes
  // match_maps when the pool size equals best_of.
  const createPool = async (size: number) => {
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );
    await postgres.query(
      `INSERT INTO _map_pool (map_pool_id, map_id)
       SELECT $1, id FROM maps WHERE type = 'Competitive' ORDER BY name LIMIT $2`,
      [pool.id, size],
    );
    return pool.id;
  };

  type OptionsOverrides = {
    type?: string;
    bestOf?: number;
    mapVeto?: boolean;
    regionVeto?: boolean;
    regions?: Array<string>;
    mapPoolId?: string;
  };

  const createOptions = async (over: OptionsOverrides = {}) => {
    const type = over.type ?? "Competitive";
    let mapPoolId = over.mapPoolId;
    if (!mapPoolId) {
      const [pool] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM map_pools WHERE type = $1 AND seed = true",
        [type === "Duel" ? "Duel" : type === "Wingman" ? "Wingman" : "Competitive"],
      );
      mapPoolId = pool.id;
    }
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       VALUES (12, $1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        over.bestOf ?? 1,
        type,
        mapPoolId,
        over.mapVeto ?? false,
        over.regionVeto ?? true,
        over.regions ?? ["TestA"],
      ],
    );
    return row.id;
  };

  type MatchRow = {
    id: string;
    lineup_1_id: string;
    lineup_2_id: string;
    status: string;
    region: string | null;
    started_at: Date | null;
    ended_at: Date | null;
    cancels_at: Date | null;
    scheduled_at: Date | null;
  };

  const createMatch = async (optionsId: string) => {
    const [match] = await postgres.query<Array<MatchRow>>(
      "INSERT INTO matches (match_options_id) VALUES ($1) RETURNING *",
      [optionsId],
    );
    return match;
  };

  const getMatch = async (id: string) => {
    const [match] = await postgres.query<Array<MatchRow>>(
      "SELECT * FROM matches WHERE id = $1",
      [id],
    );
    return match;
  };

  const setStatus = (id: string, status: string) =>
    postgres.query("UPDATE matches SET status = $1 WHERE id = $2", [
      status,
      id,
    ]);

  const addPlayer = async (lineupId: string, steamId?: string) => {
    const steam = steamId ?? (await seedPlayer());
    await postgres.query(
      "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)",
      [lineupId, steam],
    );
    return steam;
  };

  const asUser = <T>(
    steamId: string,
    role: string,
    fn: (
      query: (sql: string, params?: Array<unknown>) => Promise<unknown>,
    ) => Promise<T>,
  ) => runAsUser(postgres, steamId, role, fn);

  describe("insert (tbi_match / tai_match)", () => {
    it("auto-creates both lineups and links them back to the match", async () => {
      const match = await createMatch(await createOptions());

      expect(match.lineup_1_id).toBeDefined();
      expect(match.lineup_2_id).toBeDefined();
      expect(match.status).toBe("PickingPlayers");

      const lineups = await postgres.query<Array<{ match_id: string }>>(
        "SELECT match_id FROM match_lineups WHERE id IN ($1, $2)",
        [match.lineup_1_id, match.lineup_2_id],
      );
      expect(lineups.map((l) => l.match_id)).toEqual([match.id, match.id]);
    });

    it("auto-selects the region when only one region is viable", async () => {
      const match = await createMatch(
        await createOptions({ regions: ["TestA"] }),
      );
      expect(match.region).toBe("TestA");
    });

    it("leaves the region open when several regions are viable", async () => {
      const match = await createMatch(
        await createOptions({ regions: ["TestA", "TestB"] }),
      );
      expect(match.region).toBeNull();
    });

    it("rejects a match when region veto is disabled and no region can be resolved", async () => {
      const optionsId = await createOptions({
        regionVeto: false,
        regions: ["TestA", "TestB"],
      });
      await expect(createMatch(optionsId)).rejects.toThrow(
        /Region veto is disabled/i,
      );
    });

    it("materializes match maps when the pool exactly covers best_of", async () => {
      const match = await createMatch(
        await createOptions({ mapPoolId: await createPool(1) }),
      );

      const maps = await postgres.query<
        Array<{ order: number; lineup_1_side: string; lineup_2_side: string }>
      >(
        'SELECT "order", lineup_1_side, lineup_2_side FROM match_maps WHERE match_id = $1',
        [match.id],
      );
      expect(maps.length).toBe(1);
      expect(Number(maps[0].order)).toBe(1);
      expect(maps[0].lineup_1_side).toBe("CT");
      expect(maps[0].lineup_2_side).toBe("TERRORIST");
    });

    it("leaves maps to the veto when the pool is larger than best_of", async () => {
      const match = await createMatch(await createOptions()); // seeded 7-map pool
      const maps = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(maps.length).toBe(0);
    });
  });

  describe("pending-match guard for regular users", () => {
    // Duel keeps lineups tiny: min players is 1 per side.
    const createDuelAs = (steamId: string) =>
      asUser(steamId, "user", async (query) => {
        const [pool] = (await query(
          "SELECT id FROM map_pools WHERE type = 'Duel' AND seed = true",
        )) as Array<{ id: string }>;
        const [options] = (await query(
          `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
           VALUES (12, 1, 'Duel', $1, false, true, '{TestA}') RETURNING id`,
          [pool.id],
        )) as Array<{ id: string }>;
        const [match] = (await query(
          "INSERT INTO matches (match_options_id, organizer_steam_id) VALUES ($1, $2) RETURNING *",
          [options.id, steamId],
        )) as Array<MatchRow>;
        return match;
      });

    it("auto-joins the creator into lineup 1 as captain", async () => {
      const user = await seedPlayer();
      const match = await createDuelAs(user);

      const [player] = await postgres.query<
        Array<{ steam_id: string; captain: boolean }>
      >(
        "SELECT steam_id, captain FROM match_lineup_players WHERE match_lineup_id = $1",
        [match.lineup_1_id],
      );
      expect(player.steam_id).toBe(user);
      expect(player.captain).toBe(true);
    });

    it("blocks creating a second match while one is pending", async () => {
      const user = await seedPlayer();
      await createDuelAs(user);
      await expect(createDuelAs(user)).rejects.toThrow(/pending matches/i);
    });

    it("a match scheduled more than an hour out does not block, within an hour does", async () => {
      const user = await seedPlayer();
      const match = await createDuelAs(user);
      await addPlayer(match.lineup_2_id);

      await postgres.query(
        `UPDATE matches SET status = 'Scheduled', scheduled_at = now() + interval '2 hours' WHERE id = $1`,
        [match.id],
      );

      const second = await createDuelAs(user);
      await setStatus(second.id, "Canceled");

      await postgres.query(
        `UPDATE matches SET scheduled_at = now() + interval '30 minutes' WHERE id = $1`,
        [match.id],
      );
      await expect(createDuelAs(user)).rejects.toThrow(/pending matches/i);
    });
  });

  describe("status transitions (tbu_matches / tau_matches)", () => {
    it("refuses to schedule a match without minimum players", async () => {
      const match = await createMatch(await createOptions()); // Competitive: 5 per side
      await expect(
        postgres.query(
          `UPDATE matches SET status = 'Scheduled', scheduled_at = now() + interval '2 hours' WHERE id = $1`,
          [match.id],
        ),
      ).rejects.toThrow(/Not enough players to schedule/i);
    });

    it("clears scheduled_at when leaving the Scheduled status", async () => {
      const match = await createMatch(
        await createOptions({ mapPoolId: await createPool(1), type: "Duel" }),
      );
      await addPlayer(match.lineup_1_id);
      await addPlayer(match.lineup_2_id);

      await postgres.query(
        `UPDATE matches SET status = 'Scheduled', scheduled_at = now() + interval '2 hours' WHERE id = $1`,
        [match.id],
      );
      expect((await getMatch(match.id)).scheduled_at).not.toBeNull();

      await setStatus(match.id, "PickingPlayers");
      expect((await getMatch(match.id)).scheduled_at).toBeNull();
    });

    it("rejects going Live with no maps and map veto disabled", async () => {
      const match = await createMatch(await createOptions()); // 7-map pool, best_of 1: no maps yet
      await expect(setStatus(match.id, "Live")).rejects.toThrow(
        /no maps to play/i,
      );
    });

    it("redirects Live to Veto when map veto still needs to run", async () => {
      const match = await createMatch(await createOptions({ mapVeto: true }));
      await setStatus(match.id, "Live");

      const after = await getMatch(match.id);
      expect(after.status).toBe("Veto");
      expect(after.cancels_at).not.toBeNull();
    });

    it("redirects Live to Veto when the region still needs to be picked", async () => {
      // Region redirection only applies while the match has no maps yet — a
      // pre-picked map list means the match can go straight to a server.
      const match = await createMatch(
        await createOptions({ regions: ["TestA", "TestB"] }),
      );
      expect(match.region).toBeNull();

      await setStatus(match.id, "Live");

      const after = await getMatch(match.id);
      expect(after.status).toBe("Veto");
      expect(after.region).toBeNull();
      expect(after.cancels_at).not.toBeNull();
    });

    it("lets a match with maps go Live without a region", async () => {
      const match = await createMatch(
        await createOptions({
          mapPoolId: await createPool(1),
          regions: ["TestA", "TestB"],
        }),
      );
      expect(match.region).toBeNull();

      await setStatus(match.id, "Live");
      expect((await getMatch(match.id)).status).toBe("Live");
    });

    it("entering the check-in window arms auto-cancellation and leaving it resets check-ins", async () => {
      const match = await createMatch(
        await createOptions({ mapPoolId: await createPool(1), type: "Duel" }),
      );
      const p1 = await addPlayer(match.lineup_1_id);
      await addPlayer(match.lineup_2_id);

      await setStatus(match.id, "WaitingForCheckIn");

      const during = await getMatch(match.id);
      expect(during.cancels_at).not.toBeNull();
      // Default auto_cancel_duration is 15 minutes from now.
      const minutesOut =
        (during.cancels_at!.getTime() - Date.now()) / 60_000;
      expect(minutesOut).toBeGreaterThan(13);
      expect(minutesOut).toBeLessThan(17);

      await postgres.query(
        "UPDATE match_lineup_players SET checked_in = true WHERE steam_id = $1",
        [p1],
      );

      await setStatus(match.id, "PickingPlayers");

      const [player] = await postgres.query<Array<{ checked_in: boolean }>>(
        "SELECT checked_in FROM match_lineup_players WHERE steam_id = $1",
        [p1],
      );
      expect(player.checked_in).toBe(false);
      // cancels_at deliberately survives the exit: only WaitingForServer,
      // Live, or a finished status disarm the auto-cancel timer.
    });

    it("runs the full live flow: started_at, finish via winning lineup, server release, cancel refusal", async () => {
      const match = await createMatch(
        await createOptions({ mapPoolId: await createPool(1) }),
      );

      const [server] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM servers WHERE region = 'TestA'",
      );
      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
        [match.id, server.id],
      );
      await postgres.query("UPDATE matches SET server_id = $1 WHERE id = $2", [
        server.id,
        match.id,
      ]);

      await setStatus(match.id, "Live");
      const live = await getMatch(match.id);
      expect(live.status).toBe("Live");
      expect(live.started_at).not.toBeNull();
      expect(live.cancels_at).toBeNull();

      await postgres.query(
        "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
        [match.id],
      );

      const finished = await getMatch(match.id);
      expect(finished.status).toBe("Finished");
      expect(finished.ended_at).not.toBeNull();

      const [freed] = await postgres.query<
        Array<{ reserved_by_match_id: string | null }>
      >("SELECT reserved_by_match_id FROM servers WHERE id = $1", [server.id]);
      expect(freed.reserved_by_match_id).toBeNull();

      await expect(setStatus(match.id, "Canceled")).rejects.toThrow(
        /already finished/i,
      );
    });

    it("cancelling stamps cancels_at and clears ended_at", async () => {
      const match = await createMatch(await createOptions());
      await setStatus(match.id, "Canceled");

      const after = await getMatch(match.id);
      expect(after.status).toBe("Canceled");
      expect(after.cancels_at).not.toBeNull();
      expect(after.ended_at).toBeNull();
    });
  });

  describe("delete (tbd_matches / tad_matches)", () => {
    it("deleting a match removes its lineups and orphaned options", async () => {
      const optionsId = await createOptions({
        mapPoolId: await createPool(1),
      });
      const match = await createMatch(optionsId);

      await postgres.query("DELETE FROM matches WHERE id = $1", [match.id]);

      const lineups = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_lineups WHERE id IN ($1, $2)",
        [match.lineup_1_id, match.lineup_2_id],
      );
      expect(lineups.length).toBe(0);

      const options = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_options WHERE id = $1",
        [optionsId],
      );
      expect(options.length).toBe(0);
    });

    it("deleting a match releases any server still reserved by it", async () => {
      const match = await createMatch(
        await createOptions({ mapPoolId: await createPool(1) }),
      );
      const [server] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM servers WHERE region = 'TestB'",
      );
      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
        [match.id, server.id],
      );

      await postgres.query("DELETE FROM matches WHERE id = $1", [match.id]);

      const [freed] = await postgres.query<
        Array<{ reserved_by_match_id: string | null }>
      >("SELECT reserved_by_match_id FROM servers WHERE id = $1", [server.id]);
      expect(freed.reserved_by_match_id).toBeNull();
    });
  });
});
