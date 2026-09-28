import { PostgresService } from "./../src/postgres/postgres.service";
import { MatchImportService } from "../src/steam-match-history/match-import.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The same match brought in twice (share code + upload, a renamed file, a second
// uploader) has to resolve to the existing match instead of importing a copy.
describe("import duplicate match detection", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let findSameMatch: (
    parsed: unknown,
    players: Array<{ steam_id: string; name: string }>,
  ) => Promise<string | null>;

  beforeAll(async () => {
    db = await bootMigratedDb("ImportDuplicateMatchTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199400000000n);
    await seedRegionWithServer(postgres, "TestImportDuplicate");
    // findSameMatch only needs postgres, so skip the Nest wiring.
    const service = Object.assign(Object.create(MatchImportService.prototype), {
      postgres,
    });
    findSameMatch = (parsed, players) => service.findSameMatch(parsed, players);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM players");
  });

  // A finished 2v2 with rounds CT, T, CT on the fixture map.
  const seed = async () => {
    const ctx = await fx.bareMatch();
    const [{ name }] = await postgres.query<Array<{ name: string }>>(
      `SELECT m.name FROM match_maps mm JOIN maps m ON m.id = mm.map_id
        WHERE mm.id = $1`,
      [ctx.mapId],
    );
    const [lineups] = await postgres.query<
      Array<{ lineup_1_id: string; lineup_2_id: string }>
    >(`SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1`, [
      ctx.matchId,
    ]);
    const players = await fx.players(4);
    await fx.lineupPlayer(lineups.lineup_1_id, players[0]);
    await fx.lineupPlayer(lineups.lineup_1_id, players[1]);
    await fx.lineupPlayer(lineups.lineup_2_id, players[2]);
    await fx.lineupPlayer(lineups.lineup_2_id, players[3]);
    await fx.round(ctx.mapId, 1, { winningSide: "CT" });
    await fx.round(ctx.mapId, 2, { winningSide: "TERRORIST" });
    await fx.round(ctx.mapId, 3, { winningSide: "CT" });
    return { matchId: ctx.matchId, map: name, players };
  };

  const demo = (map: string, winners: string[]) => ({
    map_name: map,
    round_ticks: winners.map((winner, i) => ({
      round: i + 1,
      start_tick: i * 100,
      end_tick: i * 100 + 99,
      winner,
    })),
  });
  const asPlayers = (ids: string[]) =>
    ids.map((steam_id) => ({ steam_id, name: steam_id }));

  it("finds the existing match by map, round winners and players", async () => {
    const { matchId, map, players } = await seed();
    await expect(
      findSameMatch(demo(map, ["CT", "T", "CT"]), asPlayers(players)),
    ).resolves.toBe(matchId);
  });

  it("still matches with an extra player the match never had", async () => {
    const { matchId, map, players } = await seed();
    const [stranger] = await fx.players(1);
    await expect(
      findSameMatch(
        demo(map, ["CT", "T", "CT"]),
        asPlayers([...players, stranger]),
      ),
    ).resolves.toBe(matchId);
  });

  it("ignores a match with different round winners", async () => {
    const { map, players } = await seed();
    await expect(
      findSameMatch(demo(map, ["CT", "CT", "CT"]), asPlayers(players)),
    ).resolves.toBeNull();
  });

  it("ignores a match on a different map", async () => {
    const { players } = await seed();
    await expect(
      findSameMatch(
        demo("de_not_a_map", ["CT", "T", "CT"]),
        asPlayers(players),
      ),
    ).resolves.toBeNull();
  });

  it("ignores a match that shares too few players", async () => {
    const { map, players } = await seed();
    const others = await fx.players(2);
    await expect(
      findSameMatch(
        demo(map, ["CT", "T", "CT"]),
        asPlayers([players[0], players[1], ...others]),
      ),
    ).resolves.toBeNull();
  });
});
