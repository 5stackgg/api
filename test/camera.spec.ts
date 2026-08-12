import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { CameraService } from "./../src/matches/camera/camera.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Runs CameraService's real SQL (minting, revoking, token lookup) against a
// migrated database, so the queries are covered rather than re-typed here.
describe("camera tokens (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let camera: CameraService;

  beforeAll(async () => {
    db = await bootMigratedDb("CameraTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    camera = new CameraService(
      new Logger("CameraTest"),
      {} as any,
      postgres,
      {} as any,
      {} as any,
    );
    await seedRegionWithServer(postgres, "CameraTestRegion", 27015);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
  });

  const rosteredMatch = async (cameraRequired: boolean) => {
    const { poolId } = await fx.mapPool(1);
    const match = await fx.match({ mapPoolId: poolId });

    await postgres.query(
      "UPDATE match_options SET camera_required = $1 WHERE id = $2",
      [cameraRequired, match.options_id],
    );

    const steamIds = [
      await fx.lineupPlayer(match.lineup_1_id),
      await fx.lineupPlayer(match.lineup_1_id),
      await fx.lineupPlayer(match.lineup_2_id),
    ];

    return { matchId: match.id, steamIds };
  };

  const tokensFor = (matchId: string) =>
    postgres.query<Array<{ steam_id: string; token: string }>>(
      "SELECT steam_id::text AS steam_id, token::text AS token FROM match_camera_tokens WHERE match_id = $1 ORDER BY steam_id",
      [matchId],
    );

  it("mints one token per rostered player when camera_required is on", async () => {
    const { matchId, steamIds } = await rosteredMatch(true);

    await camera.generateTokensIfRequired(matchId);

    const tokens = await tokensFor(matchId);
    expect(tokens.map((row) => row.steam_id).sort()).toEqual(
      [...steamIds].sort(),
    );
    expect(new Set(tokens.map((row) => row.token)).size).toBe(steamIds.length);
  });

  it("mints nothing when camera_required is off", async () => {
    const { matchId } = await rosteredMatch(false);

    await camera.generateTokensIfRequired(matchId);

    expect(await tokensFor(matchId)).toHaveLength(0);
  });

  // The Live edge can fire more than once for a single match.
  it("is idempotent and keeps the token a player already has", async () => {
    const { matchId } = await rosteredMatch(true);

    await camera.generateTokensIfRequired(matchId);
    const first = await tokensFor(matchId);

    await camera.generateTokensIfRequired(matchId);
    const second = await tokensFor(matchId);

    expect(second).toEqual(first);
  });

  it("resolves a token to its match and player only while the match is active", async () => {
    const { matchId } = await rosteredMatch(true);
    await camera.generateTokensIfRequired(matchId);
    const [{ steam_id: steamId, token }] = await tokensFor(matchId);

    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      matchId,
    ]);
    expect(await camera.validateToken(token)).toEqual({ matchId, steamId });

    await postgres.query(
      "UPDATE matches SET status = 'Canceled' WHERE id = $1",
      [matchId],
    );
    expect(await camera.validateToken(token)).toBeNull();
  });

  it("rejects a token that is not a uuid without reaching the database", async () => {
    const failing = {
      query: jest.fn(),
    } as unknown as PostgresService;
    const guard = new CameraService(
      new Logger("CameraTest"),
      {} as any,
      failing,
      {} as any,
      {} as any,
    );

    expect(await guard.validateToken("../../etc/passwd")).toBeNull();
    expect(await guard.validateToken("")).toBeNull();
    expect(failing.query).not.toHaveBeenCalled();
  });

  it("revokes every token for a match", async () => {
    const { matchId } = await rosteredMatch(true);
    await camera.generateTokensIfRequired(matchId);

    await camera.revokeTokens(matchId);

    expect(await tokensFor(matchId)).toHaveLength(0);
  });

  it("drops tokens with the match", async () => {
    const { matchId } = await rosteredMatch(true);
    await camera.generateTokensIfRequired(matchId);

    await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);

    expect(await tokensFor(matchId)).toHaveLength(0);
  });
});
