import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { CameraService } from "./../src/matches/camera/camera.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Who may publish a camera for a match, run as real SQL against a migrated
// database so the query is covered rather than re-typed here.
//
// This used to exercise minting, revoking and looking up match_camera_tokens.
// That table is gone: the camera page is behind the ordinary login now, so
// there is no unauthenticated device to hand a bearer credential to, and the
// question the token was standing in for -- "are you in this match, while it is
// still being played" -- is asked directly.
describe("camera authorization (SQL-driven)", () => {
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

  const asUser = (steamId: string) => ({ steam_id: steamId }) as User;

  const rosteredMatch = async (status = "Live") => {
    const { poolId } = await fx.mapPool(1);
    const match = await fx.match({ mapPoolId: poolId });

    const players = [
      await fx.lineupPlayer(match.lineup_1_id),
      await fx.lineupPlayer(match.lineup_2_id),
    ];

    const coach = await fx.player();
    await postgres.query(
      "UPDATE match_lineups SET coach_steam_id = $1 WHERE id = $2",
      [coach, match.lineup_1_id],
    );

    await postgres.query("UPDATE matches SET status = $1 WHERE id = $2", [
      status,
      match.id,
    ]);

    return { matchId: match.id, players, coach };
  };

  it("admits a player rostered on either lineup", async () => {
    const { matchId, players } = await rosteredMatch();

    for (const steamId of players) {
      await expect(
        camera.assertCameraPlayer(matchId, asUser(steamId)),
      ).resolves.toBeUndefined();
    }
  });

  // A coach stands behind the team during a technical timeout, so "on camera"
  // has to mean them as well.
  it("admits the lineup's coach", async () => {
    const { matchId, coach } = await rosteredMatch();

    await expect(
      camera.assertCameraPlayer(matchId, asUser(coach)),
    ).resolves.toBeUndefined();
  });

  it("refuses somebody who is not in the match at all", async () => {
    const { matchId } = await rosteredMatch();
    const stranger = await fx.player();

    await expect(
      camera.assertCameraPlayer(matchId, asUser(stranger)),
    ).rejects.toThrow(/not authorized/i);
  });

  // Being rostered somewhere is not being rostered here.
  it("refuses a player rostered on a different match", async () => {
    const { matchId } = await rosteredMatch();
    const other = await rosteredMatch();

    await expect(
      camera.assertCameraPlayer(matchId, asUser(other.players[0])),
    ).rejects.toThrow(/not authorized/i);
  });

  // What a token's match-status check used to do on its own.
  it.each(["Finished", "Canceled", "Forfeit"])(
    "refuses once the match is %s",
    async (status) => {
      const { matchId, players } = await rosteredMatch(status);

      await expect(
        camera.assertCameraPlayer(matchId, asUser(players[0])),
      ).rejects.toThrow(/not authorized/i);
    },
  );

  it.each(["WaitingForCheckIn", "Veto", "Live", "WaitingForServer"])(
    "admits while the match is %s",
    async (status) => {
      const { matchId, players } = await rosteredMatch(status);

      await expect(
        camera.assertCameraPlayer(matchId, asUser(players[0])),
      ).resolves.toBeUndefined();
    },
  );

  // The id is interpolated into a query as a uuid, so anything else has to be
  // turned away before it gets there.
  it("rejects a match id that is not a uuid without reaching the database", async () => {
    const spy = jest.spyOn(postgres, "query");
    spy.mockClear();

    await expect(
      camera.assertCameraPlayer("../../etc/passwd", asUser("76561198000000001")),
    ).rejects.toThrow(/not authorized/i);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
