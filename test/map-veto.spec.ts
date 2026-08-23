import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the map veto SQL: get_map_veto_pattern / get_map_veto_type /
// get_map_veto_picking_lineup_id, verify_map_veto_pick enforcement, and
// create_match_map_from_veto (map materialization, side assignment, the
// auto-inserted Decider, and going Live when the veto completes).
describe("map veto (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MapVetoTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
  });

  // A match sitting in Veto: single viable region (pre-selected on insert) so
  // only the map veto is outstanding when we push it towards Live.
  const createVetoMatch = async (bestOf: number, poolSize: number) => {
    const { poolId, mapIds } = await fx.mapPool(poolSize);
    const match = await fx.match({ bestOf, mapVeto: true, mapPoolId: poolId });
    // tbu_matches redirects Live to Veto while maps are missing.
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);
    return { ...match, mapIds };
  };

  const vetoState = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{ status: string; veto_type: string | null; picking: string | null }>
    >(
      `SELECT m.status, get_map_veto_type(m) AS veto_type,
              get_map_veto_picking_lineup_id(m) AS picking
       FROM matches m WHERE m.id = $1`,
      [matchId],
    );
    return row;
  };

  const insertPick = (
    matchId: string,
    type: string,
    lineupId: string,
    mapId: string,
    side: string | null = null,
  ) =>
    postgres.query(
      `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, side)
       VALUES ($1, $2, $3, $4, $5)`,
      [matchId, type, lineupId, mapId, side],
    );

  const patternFor = async (bestOf: number, poolSize: number) => {
    const match = await createVetoMatch(bestOf, poolSize);
    const [{ pattern }] = await postgres.query<Array<{ pattern: string[] }>>(
      "SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1",
      [match.id],
    );
    return pattern;
  };

  // Drives the veto by always submitting whatever the SQL reports as next,
  // which is the actual proof a pattern completes: asserting on the pattern
  // array alone would not catch a step nothing can satisfy.
  const runVetoToCompletion = async (bestOf: number, poolSize: number) => {
    const match = await createVetoMatch(bestOf, poolSize);
    const used = new Set<string>();
    let lastPicked: string | null = null;

    for (let step = 0; step <= poolSize * 2; step++) {
      const state = await vetoState(match.id);
      if (state.status !== "Veto") {
        return match;
      }

      const remaining = match.mapIds.filter((id) => !used.has(id));
      if (state.veto_type === "Decider") {
        throw new Error(
          `Decider requested with ${remaining.length} maps left — the veto cannot progress`,
        );
      }

      if (state.veto_type === "Side") {
        await insertPick(match.id, "Side", state.picking!, lastPicked!, "CT");
        continue;
      }

      const mapId = remaining[0];
      used.add(mapId);
      if (state.veto_type === "Pick") {
        lastPicked = mapId;
      }
      await insertPick(match.id, state.veto_type!, state.picking!, mapId);
    }

    throw new Error("veto never completed");
  };

  // The same drive, but recording each step as "<type> <actor>" so turn order
  // can be asserted.
  const playOutVeto = async (bestOf: number, poolSize: number) => {
    const match = await createVetoMatch(bestOf, poolSize);
    const steps: Array<{ step: string; mapId: string }> = [];
    const used = new Set<string>();
    let lastPicked: string | null = null;

    for (let step = 0; step <= poolSize * 2; step++) {
      const state = await vetoState(match.id);
      if (state.status !== "Veto") {
        return { match, steps };
      }

      const actor = state.picking === match.lineup_1_id ? "L1" : "L2";

      if (state.veto_type === "Side") {
        steps.push({ step: `Side ${actor}`, mapId: lastPicked! });
        await insertPick(match.id, "Side", state.picking!, lastPicked!, "CT");
        continue;
      }

      const mapId = match.mapIds.filter((id) => !used.has(id))[0];
      used.add(mapId);
      if (state.veto_type === "Pick") {
        lastPicked = mapId;
      }
      steps.push({ step: `${state.veto_type} ${actor}`, mapId });
      await insertPick(match.id, state.veto_type!, state.picking!, mapId);
    }

    throw new Error("veto never completed");
  };

  it("computes the CS rulebook patterns", async () => {
    expect(await patternFor(1, 3)).toEqual(["Ban", "Ban", "Decider"]);
    expect(await patternFor(3, 4)).toEqual([
      "Ban",
      "Pick",
      "Side",
      "Pick",
      "Side",
      "Decider",
    ]);
  });

  // The worked examples in the docs, verbatim.
  // https://docs.5stack.gg/features/map-veto#examples
  it.each([
    [1, 7, ["Ban", "Ban", "Ban", "Ban", "Ban", "Ban", "Decider"]],
    [3, 5, ["Ban", "Ban", "Pick", "Side", "Pick", "Side", "Decider"]],
    [
      3,
      7,
      ["Ban", "Ban", "Pick", "Side", "Pick", "Side", "Ban", "Ban", "Decider"],
    ],
    [
      5,
      7,
      [
        "Ban",
        "Ban",
        "Pick",
        "Side",
        "Pick",
        "Side",
        "Pick",
        "Side",
        "Pick",
        "Side",
        "Decider",
      ],
    ],
  ])(
    "BO%i pool %i matches the documented example",
    async (bestOf, poolSize, expected) => {
      expect(await patternFor(bestOf as number, poolSize as number)).toEqual(
        expected,
      );
    },
  );

  it("refuses a veto on an empty map pool", async () => {
    const { poolId } = await fx.mapPool(0);
    const match = await fx.match({
      bestOf: 1,
      mapVeto: true,
      mapPoolId: poolId,
    });

    // The pool is counted, not array_agg'd: the LEFT JOIN hands back a single
    // NULL map for an empty pool, which read as a pool of one and slipped past
    // this guard into a Decider-only pattern.
    await expect(
      postgres.query(
        "SELECT get_map_veto_pattern(m) FROM matches m WHERE id = $1",
        [match.id],
      ),
    ).rejects.toThrow(/Not enough maps in the pool/i);
  });

  it("enforces type, turn, side, and pool membership", async () => {
    const match = await createVetoMatch(1, 3);

    const state = await vetoState(match.id);
    expect(state.status).toBe("Veto");
    expect(state.veto_type).toBe("Ban");
    expect(state.picking).toBe(match.lineup_1_id);

    // Wrong type for the current step.
    await expect(
      insertPick(match.id, "Pick", match.lineup_1_id, match.mapIds[0]),
    ).rejects.toThrow(/Expected pick type of Ban/i);

    // Wrong lineup for the current turn.
    await expect(
      insertPick(match.id, "Ban", match.lineup_2_id, match.mapIds[0]),
    ).rejects.toThrow(/Expected other lineup/i);

    // A Ban must not carry a side.
    await expect(
      insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0], "CT"),
    ).rejects.toThrow(/Cannot Ban and choose side/i);

    // Maps outside the match's pool are not pickable.
    const [foreignMap] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM maps WHERE type = 'Wingman' LIMIT 1",
    );
    await expect(
      insertPick(match.id, "Ban", match.lineup_1_id, foreignMap.id),
    ).rejects.toThrow(/Map not available/i);
  });

  it("rejects picks while no veto is in progress", async () => {
    const { poolId, mapIds } = await fx.mapPool(3);
    const match = await fx.match({ mapVeto: true, mapPoolId: poolId });

    // Still PickingPlayers: no veto type, no picking lineup, and the DB
    // itself rejects the pick (previously the NULL step slipped through
    // every comparison and only the Hasura permission function stood in
    // the way).
    const state = await vetoState(match.id);
    expect(state.veto_type).toBeNull();
    expect(state.picking).toBeNull();

    await expect(
      insertPick(match.id, "Ban", match.lineup_1_id, mapIds[0]),
    ).rejects.toThrow(/No map veto in progress/i);

    const [{ allowed }] = await postgres.query<
      Array<{ allowed: boolean | null }>
    >(
      `SELECT lineup_is_picking_map_veto(ml) AS allowed
       FROM match_lineups ml WHERE ml.id = $1`,
      [match.lineup_1_id],
    );
    // NULL (no active step) — Hasura treats anything but true as denied.
    expect(allowed).toBeFalsy();
  });

  it("runs a BO1 veto: alternating bans, auto-Decider, map materialized, match Live", async () => {
    const match = await createVetoMatch(1, 3);

    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);
    expect((await vetoState(match.id)).picking).toBe(match.lineup_2_id);

    await insertPick(match.id, "Ban", match.lineup_2_id, match.mapIds[1]);

    const picks = await postgres.query<Array<{ type: string; map_id: string }>>(
      "SELECT type, map_id FROM match_map_veto_picks WHERE match_id = $1 ORDER BY created_at",
      [match.id],
    );
    expect(picks.map((p) => p.type)).toEqual(["Ban", "Ban", "Decider"]);
    expect(picks[2].map_id).toBe(match.mapIds[2]);

    const maps = await postgres.query<
      Array<{ map_id: string; order: number }>
    >('SELECT map_id, "order" FROM match_maps WHERE match_id = $1', [match.id]);
    expect(maps.length).toBe(1);
    expect(maps[0].map_id).toBe(match.mapIds[2]);

    expect((await vetoState(match.id)).status).toBe("Live");
  });

  it("orders the auto-Decider strictly after the ban that triggered it", async () => {
    // The Decider is inserted by create_match_map_from_veto inside the SAME
    // transaction as the final ban. Taking the created_at default (now(), frozen
    // at transaction start) tied it with that ban, and since the veto display
    // sorts on created_at with no tiebreaker the Decider could render before the
    // ban ("ban, ..., decider, ban"). It now uses clock_timestamp() so it always
    // sorts last. Assert strict ordering (a tie would fail this).
    const match = await createVetoMatch(1, 3);

    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);
    await insertPick(match.id, "Ban", match.lineup_2_id, match.mapIds[1]);

    // Compared in SQL: the gap is microseconds, which a JS Date truncates away.
    const [row] = await postgres.query<Array<{ decider_last: boolean }>>(
      `SELECT max(created_at) FILTER (WHERE type = 'Decider')
            > max(created_at) FILTER (WHERE type = 'Ban') AS decider_last
       FROM match_map_veto_picks WHERE match_id = $1`,
      [match.id],
    );

    expect(row.decider_last).toBe(true);
  });

  it("runs the BO3 Pick/Side steps and assigns the chosen side to the picking lineup", async () => {
    const match = await createVetoMatch(3, 4);

    // Step 1: Ban (lineup 1 opens).
    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);

    // Step 2: Pick — follow whoever the SQL says is up.
    let state = await vetoState(match.id);
    expect(state.veto_type).toBe("Pick");
    const picker = state.picking!;
    await insertPick(match.id, "Pick", picker, match.mapIds[1]);

    // A Pick alone creates no map: the opposing side choice completes it.
    let maps = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(maps.length).toBe(0);

    // Step 3: Side — must be the other lineup, and a side is mandatory.
    state = await vetoState(match.id);
    expect(state.veto_type).toBe("Side");
    const sider =
      picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
    expect(state.picking).toBe(sider);

    await expect(
      insertPick(match.id, "Side", sider, match.mapIds[1]),
    ).rejects.toThrow(/Must pick a side/i);

    await insertPick(match.id, "Side", sider, match.mapIds[1], "CT");

    const [map] = await postgres.query<
      Array<{ map_id: string; lineup_1_side: string; lineup_2_side: string }>
    >(
      "SELECT map_id, lineup_1_side, lineup_2_side FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(map.map_id).toBe(match.mapIds[1]);
    // The side chooser gets the side they asked for.
    if (sider === match.lineup_1_id) {
      expect(map.lineup_1_side).toBe("CT");
      expect(map.lineup_2_side).toBe("TERRORIST");
    } else {
      expect(map.lineup_2_side).toBe("CT");
      expect(map.lineup_1_side).toBe("TERRORIST");
    }
  });

  it("deleting a veto pick removes the map it created", async () => {
    const match = await createVetoMatch(3, 4);

    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);
    const picker = (await vetoState(match.id)).picking!;
    await insertPick(match.id, "Pick", picker, match.mapIds[1]);
    const sider =
      picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
    await insertPick(match.id, "Side", sider, match.mapIds[1], "CT");

    await postgres.query(
      "DELETE FROM match_map_veto_picks WHERE match_id = $1 AND map_id = $2",
      [match.id, match.mapIds[1]],
    );

    const maps = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(maps.length).toBe(0);
  });

  // Pools larger than the hardcoded rulebook patterns get their surplus maps
  // banned up front, the way the rulebook's own opening ban phase prunes. Those
  // bans used to be appended AFTER the Decider, so once the rulebook steps ran
  // out get_map_veto_type reported 'Decider' with several maps still
  // unaccounted for: nothing could satisfy that step (the Decider is only ever
  // auto-inserted once one map is left) and every BO3/BO5 veto on a pool larger
  // than 7 hung there permanently.
  describe("pools larger than the rulebook pattern", () => {
    it.each([
      [1, 8],
      [1, 12],
      [3, 8],
      [3, 9],
      [3, 12],
      [5, 8],
      [5, 9],
      [5, 12],
    ])(
      "BO%i pool %i: the pattern covers the whole pool and ends on the Decider",
      async (bestOf, poolSize) => {
        const pattern = await patternFor(bestOf, poolSize);

        const bans = pattern.filter((type) => type === "Ban").length;
        const picks = pattern.filter((type) => type === "Pick").length;
        const sides = pattern.filter((type) => type === "Side").length;
        const deciders = pattern.filter((type) => type === "Decider").length;

        // Every map in the pool is consumed exactly once, and the maps that
        // survive to be played are the picks plus the decider.
        expect(bans + picks + deciders).toBe(poolSize);
        expect(picks + deciders).toBe(bestOf);
        expect(sides).toBe(picks);
        expect(deciders).toBe(1);
        expect(pattern[pattern.length - 1]).toBe("Decider");
      },
    );

    it.each([
      [3, 5, ["Ban", "Ban", "Pick", "Side", "Pick", "Side", "Decider"]],
      [3, 6, ["Ban", "Ban", "Pick", "Side", "Pick", "Side", "Ban", "Decider"]],
      [
        3,
        7,
        [
          "Ban",
          "Ban",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Ban",
          "Ban",
          "Decider",
        ],
      ],
      [
        5,
        6,
        [
          "Ban",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Decider",
        ],
      ],
      [
        5,
        7,
        [
          "Ban",
          "Ban",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Decider",
        ],
      ],
    ])(
      "BO%i pool %i is unchanged by the surplus-ban fix",
      async (bestOf, poolSize, expected) => {
        expect(await patternFor(bestOf as number, poolSize as number)).toEqual(
          expected,
        );
      },
    );

    // "Any extra bans a larger pool requires land after the picks and before
    // the Decider." Those bans used to be spent up front instead, so a 12 map
    // pool opened with seven straight bans before anyone picked anything.
    it.each([[2], [3], [5]])(
      "BO%i spends a larger pool's extra bans after the picks",
      async (bestOf) => {
        for (const poolSize of [8, 12, 16, 24]) {
          const pattern = await patternFor(bestOf, poolSize);
          const label = `BO${bestOf} pool ${poolSize}`;

          // The opening never grows with the pool: the picks start as soon as
          // the Ban, Ban, Pick, Pick unit reaches them.
          expect({ label, firstPick: pattern.indexOf("Pick") }).toEqual({
            label,
            firstPick: 2,
          });

          // Everything from the last side to the decider is a ban.
          const tail = pattern.slice(pattern.lastIndexOf("Side") + 1);
          expect({ label, tail: tail.slice(0, -1) }).toEqual({
            label,
            tail: Array(tail.length - 1).fill("Ban"),
          });
          expect({ label, last: tail[tail.length - 1] }).toEqual({
            label,
            last: "Decider",
          });
        }
      },
    );

    it.each([
      [
        3,
        12,
        ["Ban", "Ban", "Pick", "Side", "Pick", "Side"]
          .concat(Array(7).fill("Ban"))
          .concat(["Decider"]),
      ],
      [
        5,
        12,
        // Two turns of the unit, because a best of 5 needs four picks.
        [
          "Ban",
          "Ban",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Ban",
          "Ban",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Ban",
          "Ban",
          "Ban",
          "Decider",
        ],
      ],
    ])("BO%i pool %i follows the documented pattern", async (bestOf, poolSize, expected) => {
      expect(await patternFor(bestOf as number, poolSize as number)).toEqual(
        expected,
      );
    });

    it.each([
      [3, 12],
      [5, 12],
    ])(
      "BO%i pool %i runs to completion and goes Live",
      async (bestOf, poolSize) => {
        const match = await runVetoToCompletion(bestOf, poolSize);

        expect((await vetoState(match.id)).status).toBe("Live");

        const maps = await postgres.query<Array<{ id: string }>>(
          "SELECT id FROM match_maps WHERE match_id = $1",
          [match.id],
        );
        expect(maps.length).toBe(bestOf);

        const picks = await postgres.query<Array<{ type: string }>>(
          "SELECT type FROM match_map_veto_picks WHERE match_id = $1",
          [match.id],
        );
        expect(picks.filter((p) => p.type === "Ban").length).toBe(
          poolSize - bestOf,
        );
        expect(picks.filter((p) => p.type === "Pick").length).toBe(bestOf - 1);
        expect(picks.filter((p) => p.type === "Decider").length).toBe(1);
      },
    );
  });

  // best_of is a free integer (leagues hand out playoff_best_of / week_best_of
  // unchecked), and anything the rulebook ladder missed used to fall through
  // every branch and return a pattern of NULLs: get_map_veto_type reported no
  // step, every submitted ban was rejected as "no veto in progress", and the
  // match sat in Veto until an admin canceled it.
  describe("a best of the rulebook doesn't cover", () => {
    it.each([
      [2, 7, ["Ban", "Ban", "Pick", "Side", "Ban", "Ban", "Ban", "Decider"]],
      [
        4,
        6,
        [
          "Ban",
          "Ban",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Pick",
          "Side",
          "Decider",
        ],
      ],
    ])(
      "BO%i pool %i bans down to the maps that get played",
      async (bestOf, poolSize, expected) => {
        expect(await patternFor(bestOf as number, poolSize as number)).toEqual(
          expected,
        );
      },
    );

    it("runs to completion and goes Live", async () => {
      const match = await runVetoToCompletion(2, 7);

      expect((await vetoState(match.id)).status).toBe("Live");

      const maps = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(maps.length).toBe(2);
    });
  });

  // Pool sizes well past the rulebook ladder, and the small ones underneath it.
  // Leagues and custom pools hand out whatever count they like, so the pattern
  // has to hold for all of them, not just 5/6/7.
  describe("odd and low map pool sizes", () => {
    const bestOfs = [1, 2, 3, 4, 5, 7];

    it.each([
      [2],
      [3],
      [4],
      [5],
      [6],
      [7],
      [8],
      [9],
      [10],
      [11],
      [12],
      [13],
      [14],
      [15],
      [16],
      [20],
      [24],
    ])(
      "pool %i: every best of consumes the pool exactly once and ends on the decider",
      async (poolSize) => {
        for (const bestOf of bestOfs.filter((n) => n < poolSize)) {
          const match = await createVetoMatch(bestOf, poolSize);
          // A short seed table would quietly build a smaller pool and make the
          // rest of this vacuous.
          expect(match.mapIds.length).toBe(poolSize);

          const [{ pattern }] = await postgres.query<
            Array<{ pattern: string[] }>
          >(
            "SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1",
            [match.id],
          );

          const count = (type: string) =>
            pattern.filter((step) => step === type).length;
          const label = `BO${bestOf} pool ${poolSize}`;

          expect({ label, total: count("Ban") + count("Pick") + 1 }).toEqual({
            label,
            total: poolSize,
          });
          expect({ label, played: count("Pick") + 1 }).toEqual({
            label,
            played: bestOf,
          });
          expect({ label, sides: count("Side") }).toEqual({
            label,
            sides: count("Pick"),
          });
          expect({ label, deciders: count("Decider") }).toEqual({
            label,
            deciders: 1,
          });
          expect({ label, last: pattern[pattern.length - 1] }).toEqual({
            label,
            last: "Decider",
          });
          pattern.forEach((step, i) => {
            if (step === "Side") {
              expect({ label, before: pattern[i - 1] }).toEqual({
                label,
                before: "Pick",
              });
            }
          });
        }
      },
    );

    // The turn order regression guard. Nothing used to assert who acted when,
    // which is how a best-of-3 turn swap survived: on a pool of 8 it handed
    // BOTH picks to lineup 2, and on 12 it had lineup 2 ban twice in a row.
    it.each([
      [3, 8],
      [3, 9],
      [3, 10],
      [3, 12],
      [3, 15],
      [5, 10],
      [5, 12],
      [5, 15],
      [1, 15],
    ])(
      "BO%i pool %i: the picks snake and the bans alternate",
      async (bestOf, poolSize) => {
        const { steps } = await playOutVeto(bestOf, poolSize);
        const actor = (step: string) => step.slice(-2);

        // Picks reverse every pair: L1, L2, L2, L1, L1, L2 ...
        steps
          .filter((s) => s.step.startsWith("Pick"))
          .forEach((pick, i) => {
            const expected = Math.floor((i + 1) / 2) % 2 === 0 ? "L1" : "L2";
            expect({ pick: i, actor: actor(pick.step) }).toEqual({
              pick: i,
              actor: expected,
            });
          });

        steps.forEach((step, i) => {
          const previous = steps[i - 1];
          if (!previous) {
            return;
          }

          // Consecutive bans never land on the same team.
          if (step.step.startsWith("Ban") && previous.step.startsWith("Ban")) {
            expect({ step: i, actor: actor(step.step) }).not.toEqual({
              step: i,
              actor: actor(previous.step),
            });
          }

          // A side is always answered by the opponent of whoever picked.
          if (step.step.startsWith("Side")) {
            expect({ step: i, actor: actor(step.step) }).not.toEqual({
              step: i,
              actor: actor(previous.step),
            });
          }
        });
      },
    );

    it.each([
      [1, 10],
      [2, 10],
      [3, 10],
      [5, 10],
      [1, 12],
      [2, 12],
      [3, 12],
      [5, 12],
      [1, 15],
      [2, 15],
      [3, 15],
      [5, 15],
      [1, 2],
      [1, 3],
      [2, 3],
      [1, 4],
      [3, 4],
    ])(
      "BO%i pool %i runs to completion with the right maps left standing",
      async (bestOf, poolSize) => {
        const match = await runVetoToCompletion(bestOf, poolSize);

        const state = await vetoState(match.id);
        expect(state.status).toBe("Live");
        expect(state.veto_type).toBeNull();

        const maps = await postgres.query<Array<{ map_id: string }>>(
          "SELECT map_id FROM match_maps WHERE match_id = $1",
          [match.id],
        );
        expect(maps.length).toBe(bestOf);

        const picks = await postgres.query<
          Array<{ type: string; map_id: string }>
        >(
          "SELECT type, map_id FROM match_map_veto_picks WHERE match_id = $1 AND type <> 'Side'",
          [match.id],
        );
        expect(new Set(picks.map((p) => p.map_id)).size).toBe(poolSize);
        expect(picks.filter((p) => p.type === "Ban").length).toBe(
          poolSize - bestOf,
        );
        expect(picks.filter((p) => p.type === "Decider").length).toBe(1);
      },
    );

    it.each([
      [3, 2],
      [5, 4],
      [7, 6],
    ])(
      "BO%i on a pool of %i is refused at match creation",
      async (bestOf, poolSize) => {
        const { poolId } = await fx.mapPool(poolSize);

        await expect(
          fx.match({ bestOf, mapVeto: true, mapPoolId: poolId }),
        ).rejects.toThrow(/Not enough maps in the pool/i);
      },
    );
  });

  // https://docs.5stack.gg/features/map-veto#when-there-is-nothing-to-veto
  // A pool holding exactly best_of maps has no decision in it: every map gets
  // played, so setup_match_maps assigns them straight from the pool with
  // alternating starting sides and no veto ever runs.
  describe("when there is nothing to veto", () => {
    const goLive = async (bestOf: number, poolSize: number) => {
      const { poolId, mapIds } = await fx.mapPool(poolSize);
      const match = await fx.match({
        bestOf,
        mapVeto: true,
        mapPoolId: poolId,
      });
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
        match.id,
      ]);
      return { ...match, mapIds };
    };

    it.each([
      [1, 1],
      [3, 3],
      [5, 5],
    ])(
      "BO%i pool %i skips the veto and goes straight to the maps",
      async (bestOf, poolSize) => {
        const match = await goLive(bestOf, poolSize);

        // Map veto is on, but with nothing to veto the match stays Live
        // instead of being bounced into Veto.
        const state = await vetoState(match.id);
        expect(state.status).toBe("Live");
        expect(state.veto_type).toBeNull();
        expect(state.picking).toBeNull();

        const maps = await postgres.query<
          Array<{
            map_id: string;
            lineup_1_side: string;
            lineup_2_side: string;
          }>
        >(
          `SELECT map_id, lineup_1_side, lineup_2_side FROM match_maps
           WHERE match_id = $1 ORDER BY "order"`,
          [match.id],
        );
        expect(maps.length).toBe(bestOf);
        expect(maps.map((m) => m.map_id).sort()).toEqual(
          [...match.mapIds].sort(),
        );

        // Alternating starting sides down the series.
        maps.forEach((map, i) => {
          expect(map.lineup_1_side).toBe(i % 2 === 0 ? "CT" : "TERRORIST");
          expect(map.lineup_2_side).toBe(i % 2 === 0 ? "TERRORIST" : "CT");
        });

        const picks = await postgres.query<Array<{ id: string }>>(
          "SELECT id FROM match_map_veto_picks WHERE match_id = $1",
          [match.id],
        );
        expect(picks).toEqual([]);

        // No step is outstanding, so no pick timer is left armed.
        const [{ expires_at }] = await postgres.query<
          Array<{ expires_at: string | null }>
        >(
          "SELECT veto_pick_expires_at AS expires_at FROM matches WHERE id = $1",
          [match.id],
        );
        expect(expires_at).toBeNull();
      },
    );

    it("refuses a pick when there was nothing to veto", async () => {
      const match = await goLive(3, 3);

      await expect(
        insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]),
      ).rejects.toThrow(/No map veto in progress/i);

      const [{ allowed }] = await postgres.query<
        Array<{ allowed: boolean | null }>
      >(
        `SELECT lineup_is_picking_map_veto(ml) AS allowed
         FROM match_lineups ml WHERE ml.id = $1`,
        [match.lineup_1_id],
      );
      expect(allowed).toBeFalsy();
    });
  });

  // The 7 map active duty pool: the shape the linked CS rulebook is actually
  // written for, and the one nearly every real match runs.
  // https://github.com/ValveSoftware/counter-strike_rules_and_regs/blob/main/major-supplemental-rulebook.md#map-pick-ban
  describe("a 7 map pool", () => {
    it("BO1: the teams alternate bans down to the decider", async () => {
      const { match, steps } = await playOutVeto(1, 7);

      expect(steps.map((s) => s.step)).toEqual([
        "Ban L1",
        "Ban L2",
        "Ban L1",
        "Ban L2",
        "Ban L1",
        "Ban L2",
      ]);

      const maps = await postgres.query<Array<{ map_id: string }>>(
        'SELECT map_id FROM match_maps WHERE match_id = $1 ORDER BY "order"',
        [match.id],
      );
      expect(maps.map((m) => m.map_id)).toEqual([match.mapIds[6]]);
      expect((await vetoState(match.id)).status).toBe("Live");
    });

    it("BO3: ban, ban, pick+side, pick+side, ban, ban, decider", async () => {
      const { match, steps } = await playOutVeto(3, 7);

      // The pick pair reverses the lead, so the second ban phase opens with
      // lineup 2 and the last ban before the decider falls to lineup 1.
      expect(steps.map((s) => s.step)).toEqual([
        "Ban L1",
        "Ban L2",
        "Pick L1",
        "Side L2",
        "Pick L2",
        "Side L1",
        "Ban L2",
        "Ban L1",
      ]);

      const picked = steps
        .filter((s) => s.step.startsWith("Pick"))
        .map((s) => s.mapId);
      const banned = steps
        .filter((s) => s.step.startsWith("Ban"))
        .map((s) => s.mapId);
      const leftover = match.mapIds.filter(
        (id) => !picked.includes(id) && !banned.includes(id),
      );
      expect(leftover.length).toBe(1);

      const maps = await postgres.query<
        Array<{ map_id: string; lineup_1_side: string; lineup_2_side: string }>
      >(
        `SELECT map_id, lineup_1_side, lineup_2_side FROM match_maps
         WHERE match_id = $1 ORDER BY "order"`,
        [match.id],
      );

      // Maps are played in the order they were picked, decider last.
      expect(maps.map((m) => m.map_id)).toEqual([...picked, leftover[0]]);

      // Each pick's side went to the lineup that answered it: lineup 2 chose
      // CT on lineup 1's pick, lineup 1 chose CT on lineup 2's pick.
      expect(maps[0].lineup_2_side).toBe("CT");
      expect(maps[0].lineup_1_side).toBe("TERRORIST");
      expect(maps[1].lineup_1_side).toBe("CT");
      expect(maps[1].lineup_2_side).toBe("TERRORIST");

      const [decider] = await postgres.query<
        Array<{ map_id: string; side: string | null }>
      >(
        "SELECT map_id, side FROM match_map_veto_picks WHERE match_id = $1 AND type = 'Decider'",
        [match.id],
      );
      expect(decider.map_id).toBe(leftover[0]);
      expect(decider.side).toBeNull();

      const state = await vetoState(match.id);
      expect(state.status).toBe("Live");
      expect(state.veto_type).toBeNull();
      expect(state.picking).toBeNull();
    });

    it("BO5: ban, ban, then four picks snaking L1, L2, L2, L1", async () => {
      const { match, steps } = await playOutVeto(5, 7);

      expect(steps.map((s) => s.step)).toEqual([
        "Ban L1",
        "Ban L2",
        "Pick L1",
        "Side L2",
        "Pick L2",
        "Side L1",
        "Pick L2",
        "Side L1",
        "Pick L1",
        "Side L2",
      ]);

      const maps = await postgres.query<Array<{ map_id: string }>>(
        'SELECT map_id FROM match_maps WHERE match_id = $1 ORDER BY "order"',
        [match.id],
      );
      expect(maps.length).toBe(5);
      expect((await vetoState(match.id)).status).toBe("Live");
    });

    it.each([[1], [3], [5]])(
      "BO%i: every map in the pool is accounted for exactly once",
      async (bestOf) => {
        const match = await runVetoToCompletion(bestOf, 7);

        const picks = await postgres.query<
          Array<{ type: string; map_id: string }>
        >(
          "SELECT type, map_id FROM match_map_veto_picks WHERE match_id = $1 AND type <> 'Side'",
          [match.id],
        );
        expect(new Set(picks.map((p) => p.map_id)).size).toBe(7);
        expect(picks.filter((p) => p.type === "Decider").length).toBe(1);
        expect(picks.filter((p) => p.type === "Pick").length).toBe(bestOf - 1);
        expect(picks.filter((p) => p.type === "Ban").length).toBe(7 - bestOf);
      },
    );
  });

  // Nobody ever picks a side on the decider. It is the map neither team chose,
  // so the veto ends the moment it is inserted: no Side step is generated for
  // it, no Side row may name it, and neither captain is left on the clock.
  describe("the decider is never a side pick", () => {
    const combos: Array<[number, number]> = [
      [1, 3],
      [1, 7],
      [2, 7],
      [3, 4],
      [3, 5],
      [3, 6],
      [3, 7],
      [3, 12],
      [5, 6],
      [5, 7],
      [5, 12],
    ];

    it.each(combos)(
      "BO%i pool %i: the pattern has no Side step for the decider",
      async (bestOf, poolSize) => {
        const pattern = await patternFor(bestOf, poolSize);

        expect(pattern[pattern.length - 1]).toBe("Decider");
        expect(pattern.indexOf("Side")).toBeLessThan(
          pattern.indexOf("Decider"),
        );
        // A Side only ever answers the Pick before it.
        pattern.forEach((type, i) => {
          if (type === "Side") {
            expect(pattern[i - 1]).toBe("Pick");
          }
        });
      },
    );

    it.each(combos)(
      "BO%i pool %i: no side is chosen for the decider map",
      async (bestOf, poolSize) => {
        const match = await runVetoToCompletion(bestOf, poolSize);

        const picks = await postgres.query<
          Array<{ type: string; map_id: string; side: string | null }>
        >(
          `SELECT type, map_id, side FROM match_map_veto_picks
           WHERE match_id = $1 ORDER BY created_at`,
          [match.id],
        );

        const decider = picks.find((pick) => pick.type === "Decider");
        expect(decider).toBeDefined();
        expect(decider!.side).toBeNull();

        // The decider closes the veto: nothing is recorded after it, and no
        // Side row names its map.
        expect(picks[picks.length - 1].type).toBe("Decider");
        expect(
          picks.filter(
            (pick) => pick.type === "Side" && pick.map_id === decider!.map_id,
          ),
        ).toEqual([]);

        // Neither captain is still on the clock once the decider lands.
        const state = await vetoState(match.id);
        expect(state.status).toBe("Live");
        expect(state.veto_type).toBeNull();
        expect(state.picking).toBeNull();

        const [{ expires_at }] = await postgres.query<
          Array<{ expires_at: string | null }>
        >(
          "SELECT veto_pick_expires_at AS expires_at FROM matches WHERE id = $1",
          [match.id],
        );
        expect(expires_at).toBeNull();
      },
    );

    it("rejects a side submitted against the leftover decider map", async () => {
      // BO3 pool 4: Ban, Pick, Side, Pick, Side, Decider. After the second
      // Pick the only unvetoed map left IS the decider, so the outstanding
      // Side step answers the map that was just picked — pointing it at the
      // leftover map instead would make the decider a side pick.
      const match = await createVetoMatch(3, 4);

      await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);

      let picker = (await vetoState(match.id)).picking!;
      await insertPick(match.id, "Pick", picker, match.mapIds[1]);
      let sider =
        picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
      await insertPick(match.id, "Side", sider, match.mapIds[1], "CT");

      picker = (await vetoState(match.id)).picking!;
      await insertPick(match.id, "Pick", picker, match.mapIds[2]);

      const state = await vetoState(match.id);
      expect(state.veto_type).toBe("Side");
      sider =
        picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
      expect(state.picking).toBe(sider);

      await expect(
        insertPick(match.id, "Side", sider, match.mapIds[3], "CT"),
      ).rejects.toThrow(/side/i);

      await insertPick(match.id, "Side", sider, match.mapIds[2], "CT");

      const [decider] = await postgres.query<Array<{ map_id: string }>>(
        "SELECT map_id FROM match_map_veto_picks WHERE match_id = $1 AND type = 'Decider'",
        [match.id],
      );
      expect(decider.map_id).toBe(match.mapIds[3]);
    });
  });

  it("cancelling a match mid-veto wipes its veto picks", async () => {
    const match = await createVetoMatch(1, 3);
    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);

    await postgres.query(
      "UPDATE matches SET status = 'Canceled' WHERE id = $1",
      [match.id],
    );

    const picks = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_map_veto_picks WHERE match_id = $1",
      [match.id],
    );
    expect(picks.length).toBe(0);
  });

  // The suites above hand-check the pools people actually play (up to 15). A
  // map pool is user-built though, so it can hold every seeded Competitive map,
  // and best_of is a free integer the leagues hand out unchecked. Sweep the
  // whole range so the generalisation is exercised where nobody has written a
  // pattern out by hand.
  describe("every best-of against the widest pools", () => {
    // Every seeded Competitive map — the largest pool the panel can build.
    const MAX_POOL = 28;
    const BEST_OFS = [1, 2, 3, 4, 5, 6, 7];

    // The turn rule restated independently of the SQL that implements it:
    // teams alternate over Ban/Pick/Decider steps with lineup 1 opening, every
    // completed PAIR of picks reverses the lead (so the picks snake L1, L2, L2,
    // L1), and a Side always falls to the opponent of whoever just picked.
    const expectedSteps = (pattern: Array<string>): Array<string> => {
      const out: Array<string> = [];
      let turnIndex = 0;
      let picksMade = 0;
      let lastPicker = 1;

      for (const type of pattern) {
        if (type === "Side") {
          out.push(`Side L${lastPicker === 1 ? 2 : 1}`);
          continue;
        }

        const flipped = Math.floor(picksMade / 2) % 2 === 1;
        const team = flipped
          ? turnIndex % 2 === 0
            ? 2
            : 1
          : turnIndex % 2 === 0
            ? 1
            : 2;

        if (type === "Pick") {
          lastPicker = team;
          picksMade++;
        }
        out.push(`${type} L${team}`);
        turnIndex++;
      }

      return out;
    };

    it("has enough Competitive maps to build the widest pool", async () => {
      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*) AS count FROM maps WHERE type = 'Competitive'",
      );
      // Raise MAX_POOL when more Competitive maps are seeded.
      expect(Number(count)).toBeGreaterThanOrEqual(MAX_POOL);
    });

    describe.each(BEST_OFS)("best of %i", (bestOf) => {
      it(`stays well formed for every pool size through ${MAX_POOL}`, async () => {
        const problems: Array<string> = [];

        // A pool the size of the best-of is played whole and never vetoes.
        for (let poolSize = bestOf + 1; poolSize <= MAX_POOL; poolSize++) {
          const pattern = await patternFor(bestOf, poolSize);
          const at = `BO${bestOf} pool ${poolSize}`;
          const count = (type: string) =>
            pattern.filter((step) => step === type).length;

          const consumed = count("Ban") + count("Pick") + count("Decider");
          if (consumed !== poolSize) {
            problems.push(
              `${at}: accounts for ${consumed} of ${poolSize} maps`,
            );
          }
          if (count("Pick") + 1 !== bestOf) {
            problems.push(
              `${at}: plays ${count("Pick") + 1} maps, expected ${bestOf}`,
            );
          }
          if (count("Side") !== count("Pick")) {
            problems.push(
              `${at}: ${count("Side")} Side steps for ${count("Pick")} Picks — they pair one to one`,
            );
          }
          if (pattern.indexOf("Decider") !== pattern.length - 1) {
            problems.push(`${at}: the Decider is not the final step`);
          }
          // A Side only ever answers the Pick immediately before it. Anywhere
          // else it is a team being asked to choose a side on a map nobody
          // picked — the decider, which the knife round settles.
          pattern.forEach((type, index) => {
            if (type === "Side" && pattern[index - 1] !== "Pick") {
              problems.push(
                `${at}: Side at step ${index + 1} follows ${pattern[index - 1] ?? "nothing"}, not a Pick`,
              );
            }
          });
        }

        expect(problems).toEqual([]);
      });

      it(`plays a ${MAX_POOL}-map pool out in the documented order`, async () => {
        const pattern = await patternFor(bestOf, MAX_POOL);
        const { match, steps } = await playOutVeto(bestOf, MAX_POOL);

        // playOutVeto records only the steps a team submits; the Decider is
        // auto-inserted by create_match_map_from_veto and always closes.
        expect(steps.map((step) => step.step)).toEqual(
          expectedSteps(pattern).slice(0, -1),
        );

        // Whatever survives is the decider, and nobody chose a side on it.
        const [decider] = await postgres.query<
          Array<{ map_id: string; side: string | null }>
        >(
          "SELECT map_id, side FROM match_map_veto_picks WHERE match_id = $1 AND type = 'Decider'",
          [match.id],
        );
        expect(decider.side).toBeNull();
        expect(
          steps.filter(
            (step) =>
              step.step.startsWith("Side") && step.mapId === decider.map_id,
          ),
        ).toEqual([]);

        // The series is the picked maps in pick order, decider last.
        const picked = steps
          .filter((step) => step.step.startsWith("Pick"))
          .map((step) => step.mapId);
        const maps = await postgres.query<Array<{ map_id: string }>>(
          `SELECT map_id FROM match_maps WHERE match_id = $1 ORDER BY "order"`,
          [match.id],
        );
        expect(maps.map((m) => m.map_id)).toEqual([...picked, decider.map_id]);
        expect(maps.length).toBe(bestOf);

        expect((await vetoState(match.id)).status).toBe("Live");
      });
    });
  });
});
