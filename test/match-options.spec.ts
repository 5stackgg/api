import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the match_options triggers: the tbu_match_options edit locks
// (finished matches, invite codes, Live/Veto field freezes) and the
// tau_match_options / tad_match_options map-resync and custom-pool cleanup.
describe("match options locks (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchOptionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    // Two regions: with a single one, tbi_match_options force-disables
    // region_veto and the freeze assertions would test a no-op.
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27016);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM draft_games");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM map_pools WHERE type = 'Custom'");
    await postgres.query("DELETE FROM players");
  });

  const createPool = async (offset = 0) => {
    const { poolId, mapIds } = await fx.mapPool(1, { offset });
    return { poolId, mapId: mapIds[0] };
  };

  const createMatch = async () => {
    const { poolId, mapId } = await createPool(0);
    const match = await fx.match({ mapPoolId: poolId });
    return { matchId: match.id, optionsId: match.options_id, poolId, mapId };
  };

  // Mirrors DraftMatchService.createMatch: the draft game and the match it
  // creates point at the same match_options row.
  const createDraftGame = async (optionsId: string, matchId?: string) => {
    const host = await fx.player();
    const [draft] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO draft_games (host_steam_id, type, match_options_id, match_id)
       VALUES ($1, 'Wingman', $2, $3) RETURNING id`,
      [host, optionsId, matchId ?? null],
    );
    return draft.id;
  };

  const setMatchStatus = (matchId: string, status: string) =>
    postgres.query("UPDATE matches SET status = $1 WHERE id = $2", [
      status,
      matchId,
    ]);

  const updateOptions = (optionsId: string, set: string) =>
    postgres.query(`UPDATE match_options SET ${set} WHERE id = $1`, [
      optionsId,
    ]);

  it("locks all option edits once the match is finished", async () => {
    const { matchId, optionsId } = await createMatch();
    await setMatchStatus(matchId, "Live");
    await postgres.query(
      "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
      [matchId],
    );

    await expect(updateOptions(optionsId, "knife_round = false")).rejects.toThrow(
      /after match is finished/i,
    );
  });

  it("locks the invite code outside of PickingPlayers", async () => {
    const { matchId, optionsId } = await createMatch();

    await updateOptions(optionsId, "invite_code = '123456'");

    await setMatchStatus(matchId, "Live");
    await expect(
      updateOptions(optionsId, "invite_code = '654321'"),
    ).rejects.toThrow(/Cannot modify invite code/i);
  });

  it("freezes structural fields during Live", async () => {
    const { matchId, optionsId } = await createMatch();
    await setMatchStatus(matchId, "Live");

    await expect(updateOptions(optionsId, "best_of = 3")).rejects.toThrow(
      /Cannot modify best of/i,
    );
    await expect(updateOptions(optionsId, "map_veto = true")).rejects.toThrow(
      /Cannot modify map veto/i,
    );
    await expect(
      updateOptions(optionsId, "type = 'Wingman'"),
    ).rejects.toThrow(/Cannot modify match type/i);
    await expect(
      updateOptions(optionsId, "region_veto = false"),
    ).rejects.toThrow(/Cannot modify region veto/i);
    await expect(updateOptions(optionsId, "mr = 15")).rejects.toThrow(
      /Cannot modify mr/i,
    );

    const { poolId: otherPool } = await createPool(1);
    await expect(
      postgres.query(
        "UPDATE match_options SET map_pool_id = $1 WHERE id = $2",
        [otherPool, optionsId],
      ),
    ).rejects.toThrow(/Cannot modify map pool/i);
  });

  it("still allows cosmetic edits during Live", async () => {
    const { matchId, optionsId } = await createMatch();
    await setMatchStatus(matchId, "Live");

    await updateOptions(optionsId, "coaches = true");

    const [row] = await postgres.query<Array<{ coaches: boolean }>>(
      "SELECT coaches FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(row.coaches).toBe(true);
  });

  it("swapping the map pool before the match re-syncs its maps", async () => {
    const { matchId, optionsId, mapId } = await createMatch();

    const [before] = await postgres.query<Array<{ map_id: string }>>(
      "SELECT map_id FROM match_maps WHERE match_id = $1",
      [matchId],
    );
    expect(before.map_id).toBe(mapId);

    const { poolId: otherPool, mapId: otherMap } = await createPool(1);
    await postgres.query(
      "UPDATE match_options SET map_pool_id = $1 WHERE id = $2",
      [otherPool, optionsId],
    );

    const after = await postgres.query<Array<{ map_id: string }>>(
      "SELECT map_id FROM match_maps WHERE match_id = $1",
      [matchId],
    );
    expect(after.length).toBe(1);
    expect(after[0].map_id).toBe(otherMap);
  });

  it("deleting the match garbage-collects its options and their custom pool", async () => {
    const { matchId, optionsId, poolId } = await createMatch();

    await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);

    const options = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(options.length).toBe(0);

    const pools = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM map_pools WHERE id = $1",
      [poolId],
    );
    expect(pools.length).toBe(0);
  });

  // A draft game and the match it creates share one match_options row, and
  // tbd_matches drops the draft game while the match is still present. An
  // unconditional delete in tad_draft_games trips matches_match_options_id_fkey
  // (ON DELETE RESTRICT) here.
  it("deleting a match with a linked draft game still garbage-collects its options", async () => {
    const { matchId, optionsId } = await createMatch();
    await createDraftGame(optionsId, matchId);

    await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);

    const options = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(options.length).toBe(0);
  });

  it("deleting the draft game keeps options alive until the match goes", async () => {
    const { matchId, optionsId } = await createMatch();
    const draftId = await createDraftGame(optionsId, matchId);

    await postgres.query("DELETE FROM draft_games WHERE id = $1", [draftId]);

    const stillThere = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(stillThere.length).toBe(1);

    await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);

    const cleaned = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(cleaned.length).toBe(0);
  });

  // A scrim request shares its match_options row with the match it schedules
  // and is designed to outlive it (RemoveCancelledMatches drops canceled scrim
  // matches a day later), so the GC has to hold the row until the request goes
  // — the FK is ON DELETE SET NULL and would quietly blank the agreed settings.
  it("keeps a scrim request's options alive after its match is deleted", async () => {
    const { matchId, optionsId } = await createMatch();
    const from = await fx.team();
    const to = await fx.team();
    const [request] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO team_scrim_requests
         (from_team_id, to_team_id, requested_by_steam_id, awaiting_team_id,
          proposed_scheduled_at, expires_at, match_options_id, match_id)
       VALUES ($1, $2, $3, $2, now() + interval '1 day', now() + interval '1 day', $4, $5)
       RETURNING id`,
      [from.id, to.id, from.owner, optionsId, matchId],
    );

    await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);

    const [linked] = await postgres.query<Array<{ best_of: number }>>(
      `SELECT mo.best_of FROM team_scrim_requests r
       INNER JOIN match_options mo ON mo.id = r.match_options_id
       WHERE r.id = $1`,
      [request.id],
    );
    expect(linked.best_of).toBe(1);

    await postgres.query("DELETE FROM team_scrim_requests WHERE id = $1", [
      request.id,
    ]);

    const cleaned = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(cleaned.length).toBe(0);
  });

  it("deleting a draft game with no match garbage-collects its options", async () => {
    const { poolId } = await createPool(0);
    const optionsId = await fx.matchOptions({ mapPoolId: poolId });
    const draftId = await createDraftGame(optionsId);

    await postgres.query("DELETE FROM draft_games WHERE id = $1", [draftId]);

    const remaining = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM match_options WHERE id = $1",
      [optionsId],
    );
    expect(remaining.length).toBe(0);
  });

  // clone_match_options and update_match_options_best_of both used to carry a
  // hand-maintained column list, and both silently dropped every setting added
  // after they were written (round_restart_delay, halftime_pausematch,
  // auto_cancellation, ...) — a tournament would generate matches that ignored
  // its own options. Assert against the live column list so a new column that
  // stops round-tripping fails here rather than in production.
  describe("clone_match_options copies every column", () => {
    const columnsToCompare = async () => {
      const rows = await postgres.query<Array<{ column_name: string }>>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'match_options'
           AND column_name <> 'id'
         ORDER BY column_name`,
      );

      return rows.map((row) => row.column_name);
    };

    // Push every column off its default so a clone that drops one produces a
    // visibly different value instead of coincidentally matching.
    const createDivergentOptions = async () => {
      const { poolId } = await createPool(0);
      const optionsId = await fx.matchOptions({ mapPoolId: poolId });

      await postgres.query(
        `UPDATE match_options SET
           overtime = NOT overtime,
           knife_round = NOT knife_round,
           coaches = NOT coaches,
           map_veto = NOT map_veto,
           region_veto = NOT region_veto,
           default_models = NOT default_models,
           prefer_dedicated_server = NOT prefer_dedicated_server,
           halftime_pausematch = NOT halftime_pausematch,
           camera_required = NOT camera_required,
           auto_cancellation = NOT auto_cancellation,
           number_of_substitutes = 3,
           round_restart_delay = 17,
           tv_delay = 42,
           veto_pick_timeout = 33,
           auto_cancel_duration = 11,
           live_match_timeout = 22,
           match_mode = 'admin',
           timeout_setting = 'Admin',
           tech_timeout_setting = 'Admin',
           ready_setting = 'Captains',
           check_in_setting = 'Captains'
         WHERE id = $1`,
        [optionsId],
      );

      return optionsId;
    };

    const readOptions = async (optionsId: string, columns: Array<string>) => {
      const [row] = await postgres.query<Array<Record<string, unknown>>>(
        `SELECT ${columns.join(", ")} FROM match_options WHERE id = $1`,
        [optionsId],
      );

      return row;
    };

    it("round-trips through clone_match_options", async () => {
      const columns = await columnsToCompare();
      const optionsId = await createDivergentOptions();

      const [{ clone_match_options: clonedId }] = await postgres.query<
        Array<{ clone_match_options: string }>
      >("SELECT clone_match_options($1)", [optionsId]);

      expect(clonedId).toBeTruthy();
      expect(await readOptions(clonedId, columns)).toEqual(
        await readOptions(optionsId, columns),
      );
    });

    it("round-trips through clone_match_options_with_best_of, changing only best_of", async () => {
      const columns = await columnsToCompare();
      const optionsId = await createDivergentOptions();

      const [{ clone_match_options_with_best_of: clonedId }] =
        await postgres.query<
          Array<{ clone_match_options_with_best_of: string }>
        >("SELECT clone_match_options_with_best_of($1, 3)", [optionsId]);

      const source = await readOptions(optionsId, columns);
      const clone = await readOptions(clonedId, columns);

      expect(clone.best_of).toBe(3);
      expect({ ...clone, best_of: source.best_of }).toEqual(source);
    });
  });
});
