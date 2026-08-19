import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, seedRegionWithServer, SqlTestDb } from "./utils/sql-test-db";

// The rules that decide whether a fun mode can reach ranked play, run as real
// SQL against a migrated database. Every guard here is the last line of defence
// behind a UI filter, so it is asserted at the constraint/trigger level rather
// than through a service.
describe("game modes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("GameModesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA", 27015);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM game_mode_plugins");
    await postgres.query("DELETE FROM game_modes");
    await postgres.query("DELETE FROM game_plugin_versions");
    await postgres.query("DELETE FROM game_plugins");
  });

  const createMode = async (
    over: {
      slug?: string;
      name?: string;
      enabled?: boolean;
      competitiveSafe?: boolean;
    } = {},
  ): Promise<string> => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO game_modes (slug, name, enabled, competitive_safe)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        over.slug ?? "retakes",
        over.name ?? "Retakes",
        over.enabled ?? true,
        over.competitiveSafe ?? false,
      ],
    );
    return row.id;
  };

  const createPlugin = async (slug = "inventory-simulator"): Promise<string> => {
    await postgres.query(
      `INSERT INTO game_plugins (slug, kind, name, author, description)
       VALUES ($1, 'game', 'Test Plugin', 'tester', 'a test plugin')`,
      [slug],
    );
    return slug;
  };

  describe("registry", () => {
    it("rejects a slug that is not path-safe, since it names a directory in the plugin store", async () => {
      await expect(
        postgres.query(
          `INSERT INTO game_plugins (slug, kind, name, author, description)
           VALUES ('../escape', 'game', 'Evil', 'x', 'y')`,
        ),
      ).rejects.toThrow(/game_plugins_slug_check/);
    });

    it("rejects a version whose sha256 is not a digest", async () => {
      await createPlugin();
      await expect(
        postgres.query(
          `INSERT INTO game_plugin_versions (plugin_slug, runtime, version, url, sha256, published_at)
           VALUES ('inventory-simulator', 'swiftlys2', '1.0.0', 'https://x/y.zip', 'not-a-digest', now())`,
        ),
      ).rejects.toThrow(/game_plugin_versions_sha256_check/);
    });

    it("keeps a version pinned to a real runtime", async () => {
      await createPlugin();
      await expect(
        postgres.query(
          `INSERT INTO game_plugin_versions (plugin_slug, runtime, version, url, sha256, published_at)
           VALUES ('inventory-simulator', 'sourcemod', '1.0.0', 'https://x/y.zip', $1, now())`,
          ["a".repeat(64)],
        ),
      ).rejects.toThrow(/game_plugin_versions_runtime_fkey/);
    });

    it("drops a plugin's versions with the plugin", async () => {
      await createPlugin();
      await postgres.query(
        `INSERT INTO game_plugin_versions (plugin_slug, runtime, version, url, sha256, published_at)
         VALUES ('inventory-simulator', 'swiftlys2', '3.1.0', 'https://x/y.zip', $1, now())`,
        ["b".repeat(64)],
      );
      await postgres.query("DELETE FROM game_plugins WHERE slug = 'inventory-simulator'");
      const remaining = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM game_plugin_versions",
      );
      expect(remaining).toHaveLength(0);
    });
  });

  describe("a Ranked server never carries a persistent mode", () => {
    it("refuses to attach one", async () => {
      const modeId = await createMode();
      await expect(
        postgres.query("UPDATE servers SET game_mode_id = $1 WHERE type = 'Ranked'", [
          modeId,
        ]),
      ).rejects.toThrow(/servers_ranked_has_no_game_mode_check/);
    });

    it("refuses to promote a moded server into the Ranked pool", async () => {
      const modeId = await createMode();
      await postgres.query(
        `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled, game_mode_id)
         VALUES ('127.0.0.1', 'fun', $1, 27030, 'TestA', 'Casual', true, true, $2)`,
        [Buffer.from("password"), modeId],
      );
      await expect(
        postgres.query("UPDATE servers SET type = 'Ranked' WHERE label = 'fun'"),
      ).rejects.toThrow(/servers_ranked_has_no_game_mode_check/);
    });

    it("allows a non-Ranked server to carry one", async () => {
      const modeId = await createMode();
      await postgres.query(
        `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled, game_mode_id)
         VALUES ('127.0.0.1', 'community', $1, 27040, 'TestA', 'Casual', true, true, $2)`,
        [Buffer.from("password"), modeId],
      );
      const [server] = await postgres.query<Array<{ game_mode_id: string }>>(
        "SELECT game_mode_id FROM servers WHERE label = 'community'",
      );
      expect(server.game_mode_id).toEqual(modeId);
    });
  });

  describe("selecting a mode on a match", () => {
    it("refuses a disabled mode", async () => {
      const modeId = await createMode({ enabled: false });
      await expect(fx.matchOptions({ gameModeId: modeId })).rejects.toThrow(
        /is disabled/,
      );
    });

    // Runtime compatibility is derived from the plugins, so a mode holding a
    // plugin with no build for this deployment is refused by name.
    it("refuses a mode whose plugin has no build for this runtime", async () => {
      const modeId = await createMode();
      await createPlugin("css-only");
      await postgres.query(
        `INSERT INTO game_plugin_versions (plugin_slug, runtime, version, url, sha256, published_at)
         VALUES ('css-only', 'counterstrikesharp', '1.0.0', 'https://x/y.zip', $1, now())`,
        ["c".repeat(64)],
      );
      await postgres.query(
        "INSERT INTO game_mode_plugins (game_mode_id, plugin_slug) VALUES ($1, 'css-only')",
        [modeId],
      );

      const optionsId = await fx.matchOptions();
      await expect(
        postgres.query("UPDATE match_options SET game_mode_id = $1 WHERE id = $2", [
          modeId,
          optionsId,
        ]),
      ).rejects.toThrow(/css-only which has no swiftlys2 build/);
    });

    it("accepts a mode whose plugin ships for this runtime", async () => {
      const modeId = await createMode();
      await createPlugin("both-runtimes");
      for (const runtime of ["swiftlys2", "counterstrikesharp"]) {
        await postgres.query(
          `INSERT INTO game_plugin_versions (plugin_slug, runtime, version, url, sha256, published_at)
           VALUES ('both-runtimes', $1, '1.0.0', 'https://x/y.zip', $2, now())`,
          [runtime, "d".repeat(64)],
        );
      }
      await postgres.query(
        "INSERT INTO game_mode_plugins (game_mode_id, plugin_slug) VALUES ($1, 'both-runtimes')",
        [modeId],
      );

      const optionsId = await fx.matchOptions();
      await postgres.query(
        "UPDATE match_options SET game_mode_id = $1 WHERE id = $2",
        [modeId, optionsId],
      );

      const [options] = await postgres.query<Array<{ game_mode_id: string }>>(
        "SELECT game_mode_id FROM match_options WHERE id = $1",
        [optionsId],
      );
      expect(options.game_mode_id).toEqual(modeId);
    });

    it("reports a mode with no plugins as runnable on every runtime", async () => {
      const modeId = await createMode();

      const [row] = await postgres.query<Array<{ runtimes: Array<string> }>>(
        `SELECT game_mode_supported_runtimes(m.*) AS runtimes FROM game_modes m WHERE id = $1`,
        [modeId],
      );

      expect(row.runtimes.sort()).toEqual([
        "counterstrikesharp",
        "swiftlys2",
      ]);
    });

    // The case a hand-picked runtime could never catch.
    it("reports an impossible selection as running nowhere", async () => {
      const modeId = await createMode();

      for (const [slug, runtime] of [
        ["sw-only", "swiftlys2"],
        ["css-only", "counterstrikesharp"],
      ]) {
        await createPlugin(slug);
        await postgres.query(
          `INSERT INTO game_plugin_versions (plugin_slug, runtime, version, url, sha256, published_at)
           VALUES ($1, $2, '1.0.0', 'https://x/y.zip', $3, now())`,
          [slug, runtime, "e".repeat(64)],
        );
        await postgres.query(
          "INSERT INTO game_mode_plugins (game_mode_id, plugin_slug) VALUES ($1, $2)",
          [modeId, slug],
        );
      }

      const [row] = await postgres.query<Array<{ runtimes: Array<string> }>>(
        `SELECT game_mode_supported_runtimes(m.*) AS runtimes FROM game_modes m WHERE id = $1`,
        [modeId],
      );

      expect(row.runtimes).toEqual([]);
    });

    it("accepts a mode with no plugins at all", async () => {
      const modeId = await createMode();
      const optionsId = await fx.matchOptions();
      await postgres.query("UPDATE match_options SET game_mode_id = $1 WHERE id = $2", [
        modeId,
        optionsId,
      ]);
      const [options] = await postgres.query<Array<{ game_mode_id: string }>>(
        "SELECT game_mode_id FROM match_options WHERE id = $1",
        [optionsId],
      );
      expect(options.game_mode_id).toEqual(modeId);
    });

    it("refuses to change the mode once the match is Live", async () => {
      const modeId = await createMode();
      const { poolId } = await fx.mapPool(1);
      const match = await fx.match({ mapPoolId: poolId, bestOf: 1 });
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [match.id]);
      await expect(
        postgres.query("UPDATE match_options SET game_mode_id = $1 WHERE id = $2", [
          modeId,
          match.options_id,
        ]),
      ).rejects.toThrow(/Cannot modify game mode during Live\/Veto/);
    });
  });

  describe("retiring a mode", () => {
    it("refuses to delete one any match has used, and says to archive it", async () => {
      const modeId = await createMode();
      const match = await fx.match();
      await postgres.query("UPDATE match_options SET game_mode_id = $1 WHERE id = $2", [
        modeId,
        match.options_id,
      ]);
      await expect(
        postgres.query("DELETE FROM game_modes WHERE id = $1", [modeId]),
      ).rejects.toThrow(/archive it instead of deleting it/);
    });

    it("still refuses after that match is finished, so history is not rewritten", async () => {
      const modeId = await createMode();
      const match = await fx.match();
      await postgres.query("UPDATE match_options SET game_mode_id = $1 WHERE id = $2", [
        modeId,
        match.options_id,
      ]);
      await postgres.query("UPDATE matches SET status = 'Finished' WHERE id = $1", [
        match.id,
      ]);
      await expect(
        postgres.query("DELETE FROM game_modes WHERE id = $1", [modeId]),
      ).rejects.toThrow(/archive it instead of deleting it/);
    });

    it("archives instead, keeping the finished match pointed at it", async () => {
      const modeId = await createMode();
      const match = await fx.match();
      await postgres.query("UPDATE match_options SET game_mode_id = $1 WHERE id = $2", [
        modeId,
        match.options_id,
      ]);
      await postgres.query("UPDATE matches SET status = 'Finished' WHERE id = $1", [
        match.id,
      ]);
      await postgres.query("UPDATE game_modes SET archived_at = now() WHERE id = $1", [
        modeId,
      ]);
      const [options] = await postgres.query<Array<{ game_mode_id: string | null }>>(
        "SELECT game_mode_id FROM match_options WHERE id = $1",
        [match.options_id],
      );
      expect(options.game_mode_id).toEqual(modeId);
    });

    it("refuses to select an archived mode for a new match", async () => {
      const modeId = await createMode();
      await postgres.query("UPDATE game_modes SET archived_at = now() WHERE id = $1", [
        modeId,
      ]);
      await expect(fx.matchOptions({ gameModeId: modeId })).rejects.toThrow(
        /is archived/,
      );
    });

    it("deletes cleanly when nothing has ever used it", async () => {
      const modeId = await createMode();
      await postgres.query("DELETE FROM game_modes WHERE id = $1", [modeId]);
      const remaining = await postgres.query<Array<unknown>>("SELECT 1 FROM game_modes");
      expect(remaining).toHaveLength(0);
    });

    it("takes its plugin selections with it", async () => {
      const modeId = await createMode();
      const slug = await createPlugin();
      await postgres.query(
        "INSERT INTO game_mode_plugins (game_mode_id, plugin_slug) VALUES ($1, $2)",
        [modeId, slug],
      );
      await postgres.query("DELETE FROM game_modes WHERE id = $1", [modeId]);
      const remaining = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM game_mode_plugins",
      );
      expect(remaining).toHaveLength(0);
    });

    it("refuses to drop a plugin a mode still selects", async () => {
      const modeId = await createMode();
      const slug = await createPlugin();
      await postgres.query(
        "INSERT INTO game_mode_plugins (game_mode_id, plugin_slug) VALUES ($1, $2)",
        [modeId, slug],
      );
      await expect(
        postgres.query("DELETE FROM game_plugins WHERE slug = $1", [slug]),
      ).rejects.toThrow(/game_mode_plugins_plugin_fkey/);
    });
  });
});

// A match under any custom mode still plays for real on a real server: stats,
// demos and rounds are all recorded. It simply moves nobody's rating and stays
// off the stats leaderboards -- only a plain competitive match counts, and
// competitive_safe gates draft-lobby selection rather than ranking.
describe("unranked game modes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("UnrankedModesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA", 27015);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_elo");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM game_modes");
    await postgres.query("DELETE FROM players");
  });

  const mode = async (competitiveSafe: boolean): Promise<string> => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO game_modes (slug, name, competitive_safe)
       VALUES ($1, $1, $2) RETURNING id`,
      [competitiveSafe ? "ranked-mode" : "fun-mode", competitiveSafe],
    );
    return row.id;
  };

  const playedMatch = async (gameModeId?: string) => {
    const optionsId = await fx.matchOptions({
      type: "Duel",
      gameModeId,
    });
    const match = await fx.match(optionsId);
    await fx.lineupPlayer(match.lineup_1_id);
    await fx.lineupPlayer(match.lineup_2_id);
    await postgres.query(
      `UPDATE matches
          SET winning_lineup_id = lineup_1_id,
              ended_at = now() - interval '1 day',
              status = 'Finished'
        WHERE id = $1`,
      [match.id],
    );
    return match;
  };

  const generate = async (matchId: string): Promise<number> => {
    const [row] = await postgres.query<
      Array<{ generate_player_elo_for_match: number }>
    >("SELECT generate_player_elo_for_match($1)", [matchId]);
    return Number(row.generate_player_elo_for_match);
  };

  const lineupSteamIds = async (match: {
    lineup_1_id: string;
    lineup_2_id: string;
  }): Promise<[string, string]> => {
    const pick = async (lineupId: string) => {
      const [row] = await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id FROM match_lineup_players WHERE match_lineup_id = $1 LIMIT 1",
        [lineupId],
      );
      return String(row.steam_id);
    };

    return [await pick(match.lineup_1_id), await pick(match.lineup_2_id)];
  };

  const eloRowCount = async (matchId: string): Promise<number> => {
    const rows = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM player_elo WHERE match_id = $1",
      [matchId],
    );
    return rows.length;
  };

  it("marks a match under an unsafe mode as not counting, at creation", async () => {
    const match = await playedMatch(await mode(false));

    const [row] = await postgres.query<
      Array<{ counts_toward_ranking: boolean }>
    >("SELECT counts_toward_ranking FROM matches WHERE id = $1", [match.id]);

    expect(row.counts_toward_ranking).toBe(false);
  });

  it("marks a match under a draft-eligible mode as not counting either", async () => {
    const match = await playedMatch(await mode(true));

    const [row] = await postgres.query<
      Array<{ counts_toward_ranking: boolean }>
    >("SELECT counts_toward_ranking FROM matches WHERE id = $1", [match.id]);

    expect(row.counts_toward_ranking).toBe(false);
  });

  it("counts a match with no mode at all", async () => {
    const match = await playedMatch();

    const [row] = await postgres.query<
      Array<{ counts_toward_ranking: boolean }>
    >("SELECT counts_toward_ranking FROM matches WHERE id = $1", [match.id]);

    expect(row.counts_toward_ranking).toBe(true);
  });

  it("writes no ELO for an unranked match", async () => {
    const match = await playedMatch(await mode(false));

    expect(await generate(match.id)).toEqual(0);
    expect(await eloRowCount(match.id)).toEqual(0);
  });

  it("writes ELO for the same match with no mode", async () => {
    const match = await playedMatch();

    expect(await generate(match.id)).toBeGreaterThan(0);
    expect(await eloRowCount(match.id)).toBeGreaterThan(0);
  });

  it("follows the mode when it is cleared before the match is played", async () => {
    const optionsId = await fx.matchOptions({
      type: "Duel",
      gameModeId: await mode(true),
    });
    const match = await fx.match(optionsId);

    const before = await postgres.query<
      Array<{ counts_toward_ranking: boolean }>
    >("SELECT counts_toward_ranking FROM matches WHERE id = $1", [match.id]);
    expect(before[0].counts_toward_ranking).toBe(false);

    await postgres.query(
      "UPDATE match_options SET game_mode_id = NULL WHERE id = $1",
      [optionsId],
    );

    const [row] = await postgres.query<
      Array<{ counts_toward_ranking: boolean }>
    >("SELECT counts_toward_ranking FROM matches WHERE id = $1", [match.id]);

    expect(row.counts_toward_ranking).toBe(true);
  });

  // The decision is stored, not derived, so history cannot be rewritten by
  // editing a mode long after the matches were played.
  // Not just "no rows written": the rating the player carries must be the same
  // number afterwards, and the next ranked match has to pick up from there. An
  // unranked match that left a trace in the chain would move ratings without
  // ever appearing to.
  it("leaves a rating untouched and does not poison the next ranked match", async () => {
    const safe = await mode(true);
    const unsafe = await mode(false);
    const alice = await fx.player();
    const bob = await fx.player();

    const play = async (gameModeId?: string) => {
      const optionsId = await fx.matchOptions({ type: "Duel", gameModeId });
      const match = await fx.match(optionsId);
      await fx.lineupPlayer(match.lineup_1_id, alice);
      await fx.lineupPlayer(match.lineup_2_id, bob);
      await postgres.query(
        `UPDATE matches
            SET winning_lineup_id = lineup_1_id,
                ended_at = now() - interval '1 day',
                status = 'Finished'
          WHERE id = $1`,
        [match.id],
      );
      await generate(match.id);
      return match;
    };

    const ratingOf = async (steamId: string): Promise<number | null> => {
      const [row] = await postgres.query<Array<{ current: string }>>(
        `SELECT current FROM player_elo
          WHERE steam_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [steamId],
      );
      return row ? Number(row.current) : null;
    };

    await play();
    const afterRanked = await ratingOf(alice);
    expect(afterRanked).not.toBeNull();

    // Neither flavor of mode moves the rating -- draft-eligible or not.
    await play(unsafe);
    expect(await ratingOf(alice)).toEqual(afterRanked);
    await play(safe);
    expect(await ratingOf(alice)).toEqual(afterRanked);

    // And the engine still works afterwards -- the unranked matches in between
    // did not leave the chain in a state the next one refuses to build on.
    await play();
    expect(await ratingOf(alice)).not.toEqual(afterRanked);
  });

  // The point of an unranked mode is that everything else about the match is
  // real. If this ever stops being true, fun modes stop being playable rather
  // than just unranked.
  it("still records kills for an unranked match", async () => {
    const gameModeId = await mode(false);
    const match = await playedMatch(gameModeId);

    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [match.id],
    );

    const [attacker, victim] = await lineupSteamIds(match);
    await fx.kill({ matchId: match.id, mapId: map.id }, attacker, victim);

    const kills = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM player_kills WHERE match_id = $1",
      [match.id],
    );

    expect(kills).toHaveLength(1);
    expect(await eloRowCount(match.id)).toBe(0);
  });

  it("keeps an unranked match off the leaderboard", async () => {
    const build = async (gameModeId?: string) => {
      const match = await playedMatch(gameModeId);
      const [map] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_maps (match_id, map_id, "order")
         SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
        [match.id],
      );
      const [attacker, victim] = await lineupSteamIds(match);
      await fx.kill({ matchId: match.id, mapId: map.id }, attacker, victim);
      return attacker;
    };

    const unrankedPlayer = await build(await mode(true));

    const onBoard = async () => {
      const rows = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM get_leaderboard('best_kdr', 0)",
      );
      return rows.map((row) => String(row.player_steam_id));
    };

    expect(await onBoard()).not.toContain(String(unrankedPlayer));

    // The same shape with no mode does appear, so the assertion above is
    // about the ranking flag and not about the fixture being incomplete.
    const rankedPlayer = await build();
    expect(await onBoard()).toContain(String(rankedPlayer));
  });

  it("does not change a played match when the mode's flag is flipped later", async () => {
    const funMode = await mode(false);
    const match = await playedMatch(funMode);

    await postgres.query(
      "UPDATE game_modes SET competitive_safe = true WHERE id = $1",
      [funMode],
    );

    const [row] = await postgres.query<
      Array<{ counts_toward_ranking: boolean }>
    >("SELECT counts_toward_ranking FROM matches WHERE id = $1", [match.id]);

    expect(row.counts_toward_ranking).toBe(false);
  });
});

// The starter modes are seeded on every boot, so they have to survive an
// operator editing them and re-apply without duplicating anything.
describe("starter game modes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("StarterModesTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  // Exactly what HasuraService.setup() does on every boot for hasura/enums.
  const reapply = async (): Promise<void> => {
    await postgres.query(
      readFileSync(join(__dirname, "..", "hasura/enums/game-modes.sql"), "utf8"),
    );
  };

  const seeded = async (): Promise<Array<Record<string, any>>> =>
    await postgres.query(
      `SELECT slug, name, enabled, competitive_safe, cfg
         FROM game_modes WHERE slug IN ('retakes','deathmatch')
        ORDER BY slug`,
    );

  it("ships retakes and deathmatch out of the box", async () => {
    const modes = await seeded();
    expect(modes.map((mode) => mode.slug)).toEqual(["deathmatch", "retakes"]);
  });

  it("keeps them out of draft lobbies by default", async () => {
    const modes = await seeded();
    expect(modes.every((mode) => mode.competitive_safe === false)).toBe(true);
  });

  it("gives each one a cvar block", async () => {
    const modes = await seeded();
    expect(modes.every((mode) => (mode.cfg ?? "").includes("mp_"))).toBe(true);
  });

  // The file is re-applied on every boot; a second pass must not duplicate.
  it("re-applies without duplicating", async () => {
    const before = await seeded();
    await reapply();
    const after = await seeded();

    expect(after.length).toEqual(before.length);
  });

  it("keeps an operator's edits when it re-applies", async () => {
    await postgres.query(
      `UPDATE game_modes
          SET enabled = false, competitive_safe = true, cfg = 'mp_freezetime 99'
        WHERE slug = 'retakes'`,
    );

    await reapply();

    const [retakes] = await postgres.query<Array<Record<string, any>>>(
      `SELECT enabled, competitive_safe, cfg FROM game_modes WHERE slug = 'retakes'`,
    );

    expect(retakes.enabled).toBe(false);
    expect(retakes.competitive_safe).toBe(true);
    expect(retakes.cfg).toEqual("mp_freezetime 99");
  });
});
