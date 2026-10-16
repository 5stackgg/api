import { PostgresService } from "./../src/postgres/postgres.service";
import { ExtensionService } from "../src/extension/extension.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

const ROOM = "1-c0d53305-38d8-4d84-9f40-cd0a6032e5bd";
const OTHER_ROOM = "1-21f1f713-81f9-4f67-808d-edda1e977d85";

describe("extension FACEIT lookup", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let service: ExtensionService;

  beforeAll(async () => {
    db = await bootMigratedDb("ExtensionFaceitLookupTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199420000000n);
    await seedRegionWithServer(postgres, "TestExtensionLookup");
    const noJobs = { getJob: async (): Promise<undefined> => undefined };
    service = new ExtensionService(
      postgres,
      {} as never,
      {} as never,
      {} as never,
      noJobs as never,
      noJobs as never,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
  });

  const imported = async (externalId: string) => {
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      `UPDATE matches SET source = 'faceit', external_id = $2 WHERE id = $1`,
      [matchId, externalId],
    );
    return matchId;
  };

  it("finds each map of a series by its own external id", async () => {
    const first = await imported(ROOM);
    const second = await imported(`${ROOM}.2`);

    const result = await service.lookupFaceit([
      { id: ROOM, maps: 2 },
      { id: OTHER_ROOM },
    ]);

    expect(result[ROOM].state).toBe("imported");
    expect(result[ROOM].match_ids.sort()).toEqual([first, second].sort());
    expect(result[OTHER_ROOM]).toEqual({ state: "none", match_ids: [] });
  });

  it("still offers the rest of a series that is only partly in", async () => {
    const first = await imported(ROOM);

    await expect(
      service.lookupFaceit([{ id: ROOM, maps: 3 }]),
    ).resolves.toEqual({ [ROOM]: { state: "none", match_ids: [first] } });
  });

  it("knows a player's FACEIT account once 5Stack has linked it", async () => {
    const steamId = await fx.player();
    await expect(service.faceitAccount(steamId)).resolves.toBeNull();

    await postgres.query(
      `UPDATE players SET faceit_player_id = $2, faceit_nickname = $3
        WHERE steam_id = $1::bigint`,
      [steamId, "ac71ba3c-d3d4-45e7-8be2-26aa3986867d", "LukePOLO"],
    );
    await expect(service.faceitAccount(steamId)).resolves.toEqual({
      player_id: "ac71ba3c-d3d4-45e7-8be2-26aa3986867d",
      nickname: "LukePOLO",
    });
  });

  it("does not count a Valve match that happens to share the id", async () => {
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      `UPDATE matches SET source = 'valve', external_id = $2 WHERE id = $1`,
      [matchId, ROOM],
    );

    await expect(service.lookupFaceit([{ id: ROOM }])).resolves.toEqual({
      [ROOM]: { state: "none", match_ids: [] },
    });
  });
});
