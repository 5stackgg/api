import { PostgresService } from "./../src/postgres/postgres.service";
import { SanctionsService } from "./../src/sanctions/sanctions.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// A warning is a note on the player's record: nothing that enforces a sanction
// may read it as one, and it never gets an end date.
describe("warning sanctions (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("SanctionsWarningTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196200000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM players");
  });

  const sanction = async (
    steamId: string,
    type: string,
    removeSanctionDate: string | null = null,
  ) => {
    const [row] = await postgres.query<
      Array<{ id: string; remove_sanction_date: Date | null }>
    >(
      `INSERT INTO player_sanctions
         (player_steam_id, type, reason, remove_sanction_date)
       VALUES ($1::bigint, $2, 'reason', $3::timestamptz)
       RETURNING id, remove_sanction_date`,
      [steamId, type, removeSanctionDate],
    );
    return row;
  };

  const flags = async (steamId: string) => {
    const [row] = await postgres.query<
      Array<{
        is_banned: boolean;
        is_muted: boolean;
        is_gagged: boolean;
        is_admin_sanctioned: boolean;
        banned_until: Date | null;
      }>
    >(
      `SELECT public.is_banned(p)           AS is_banned,
              public.is_muted(p)            AS is_muted,
              public.is_gagged(p)           AS is_gagged,
              public.is_admin_sanctioned(p) AS is_admin_sanctioned,
              public.banned_until(p)        AS banned_until
         FROM players p
        WHERE p.steam_id = $1::bigint`,
      [steamId],
    );
    return row;
  };

  const service = () =>
    new SanctionsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {} as any,
      postgres,
      {} as any,
      {} as any,
    );

  it("enforces nothing on a player whose only sanction is a warning", async () => {
    const steamId = await fx.player();
    const moderator = await fx.player();
    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, type, reason, sanctioned_by_steam_id)
       VALUES ($1::bigint, 'warning', 'toxic', $2::bigint)`,
      [steamId, moderator],
    );

    expect(await flags(steamId)).toEqual({
      is_banned: false,
      is_muted: false,
      is_gagged: false,
      is_admin_sanctioned: false,
      banned_until: null,
    });
  });

  it("still enforces the real sanctions next to a warning", async () => {
    const steamId = await fx.player();
    await sanction(steamId, "warning");
    await sanction(steamId, "silence");

    expect(await flags(steamId)).toMatchObject({
      is_banned: false,
      is_muted: true,
      is_gagged: true,
    });
  });

  it("drops an end date given to a warning on insert", async () => {
    const steamId = await fx.player();
    const row = await sanction(
      steamId,
      "warning",
      new Date(Date.now() + 86_400_000).toISOString(),
    );

    expect(row.remove_sanction_date).toBeNull();
  });

  it("drops an end date given to a warning on update", async () => {
    const steamId = await fx.player();
    const { id } = await sanction(steamId, "warning");

    await postgres.query(
      `UPDATE player_sanctions
          SET remove_sanction_date = now() + interval '1 day'
        WHERE id = $1`,
      [id],
    );

    const [row] = await postgres.query<
      Array<{ remove_sanction_date: Date | null }>
    >("SELECT remove_sanction_date FROM player_sanctions WHERE id = $1", [id]);
    expect(row.remove_sanction_date).toBeNull();
  });

  it("leaves the end date of every other type alone", async () => {
    const steamId = await fx.player();
    const row = await sanction(
      steamId,
      "mute",
      new Date(Date.now() + 86_400_000).toISOString(),
    );

    expect(row.remove_sanction_date).not.toBeNull();
  });

  it("never hands a warning to the game server", async () => {
    const warned = await fx.player();
    const muted = await fx.player();
    await sanction(warned, "warning");
    await sanction(muted, "mute");

    expect(await service().getActiveServerSanctions("server-1")).toEqual([
      { steam_id: muted, is_banned: false, is_muted: true, is_gagged: false },
    ]);
  });

  it("removes one warning by id and leaves the rest of the record", async () => {
    const steamId = await fx.player();
    const first = await sanction(steamId, "warning");
    const second = await sanction(steamId, "warning");

    const result = await service().unsanctionServerPlayer({
      steamId,
      type: "warning",
      sanctionId: first.id,
    });

    expect(result.id).toBe(first.id);
    const active = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM player_sanctions
        WHERE player_steam_id = $1::bigint
          AND deleted_at IS NULL`,
      [steamId],
    );
    expect(active.map(({ id }) => id)).toEqual([second.id]);
  });

  it("will not remove somebody else's sanction by id", async () => {
    const steamId = await fx.player();
    const other = await fx.player();
    const theirs = await sanction(other, "warning");

    await expect(
      service().unsanctionServerPlayer({
        steamId,
        type: "warning",
        sanctionId: theirs.id,
      }),
    ).rejects.toThrow("sanction not found");

    const [row] = await postgres.query<Array<{ deleted_at: Date | null }>>(
      "SELECT deleted_at FROM player_sanctions WHERE id = $1",
      [theirs.id],
    );
    expect(row.deleted_at).toBeNull();
  });
});
