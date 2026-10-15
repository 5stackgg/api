import { PostgresService } from "./../src/postgres/postgres.service";
import { SanctionsService } from "./../src/sanctions/sanctions.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

describe("sanction role hierarchy (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("SanctionsHierarchyTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561196300000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM players");
  });

  const playerWithRole = (role: string) => fx.player(undefined, role);

  const sanction = (
    target: string,
    sanctionedBy: string | null,
    type = "ban",
    query: (
      sql: string,
      params?: Array<unknown>,
    ) => Promise<unknown> = postgres.query.bind(postgres),
  ) =>
    query(
      `INSERT INTO player_sanctions
         (player_steam_id, type, reason, sanctioned_by_steam_id)
       VALUES ($1::bigint, $2, 'reason', $3::bigint)
       RETURNING id`,
      [target, type, sanctionedBy],
    ) as Promise<Array<{ id: string }>>;

  const sanctionsOn = async (steamId: string) =>
    (
      await postgres.query<Array<{ count: string }>>(
        "SELECT count(*) FROM player_sanctions WHERE player_steam_id = $1::bigint",
        [steamId],
      )
    )[0].count;

  it("refuses a moderator sanctioning an administrator", async () => {
    const moderator = await playerWithRole("moderator");
    const administrator = await playerWithRole("administrator");

    await expect(sanction(administrator, moderator)).rejects.toThrow(
      /equal to or above/,
    );
    expect(await sanctionsOn(administrator)).toBe("0");
  });

  it("refuses every sanction type, warnings included", async () => {
    const moderator = await playerWithRole("moderator");
    const administrator = await playerWithRole("administrator");

    for (const type of ["mute", "gag", "silence", "warning"]) {
      await expect(sanction(administrator, moderator, type)).rejects.toThrow(
        /equal to or above/,
      );
    }
  });

  it("refuses sanctioning an equal role, administrators included", async () => {
    const moderator = await playerWithRole("moderator");
    const otherModerator = await playerWithRole("moderator");
    const administrator = await playerWithRole("administrator");
    const otherAdministrator = await playerWithRole("administrator");

    await expect(sanction(otherModerator, moderator)).rejects.toThrow(
      /equal to or above/,
    );
    await expect(sanction(otherAdministrator, administrator)).rejects.toThrow(
      /equal to or above/,
    );
  });

  it("refuses the api's admin-secret insert the same way", async () => {
    const moderator = await playerWithRole("moderator");
    const organizer = await playerWithRole("match_organizer");

    await expect(
      runAsUser(postgres, "0", "admin", (query) =>
        sanction(organizer, moderator, "ban", query),
      ),
    ).rejects.toThrow(/equal to or above/);
  });

  it("refuses a sanctioner who is not a player at all", async () => {
    const user = await playerWithRole("user");

    await expect(sanction(user, "76561196399999999")).rejects.toThrow();
  });

  it("lets a role sanction anyone below it", async () => {
    const moderator = await playerWithRole("moderator");
    const administrator = await playerWithRole("administrator");
    const user = await playerWithRole("user");
    const streamer = await playerWithRole("streamer");
    const organizer = await playerWithRole("tournament_organizer");

    await sanction(user, moderator);
    await sanction(streamer, moderator, "mute");
    await sanction(organizer, administrator);
    await sanction(moderator, administrator, "warning");

    expect(await sanctionsOn(user)).toBe("1");
    expect(await sanctionsOn(streamer)).toBe("1");
    expect(await sanctionsOn(organizer)).toBe("1");
    expect(await sanctionsOn(moderator)).toBe("1");
  });

  const service = () => {
    const hasura = { mutation: jest.fn().mockResolvedValue({}) };
    const rconService = { connect: jest.fn(), disconnect: jest.fn() };
    const dedicatedServers = {
      getServerPlayerList: jest.fn().mockResolvedValue([]),
      resolveServerUserId: jest.fn().mockResolvedValue("4"),
    };
    return {
      hasura,
      rconService,
      sanctions: new SanctionsService(
        { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
        hasura as any,
        postgres,
        rconService as any,
        dedicatedServers as any,
      ),
    };
  };

  it("refuses the sanction and kick actions before they do anything", async () => {
    const moderator = await playerWithRole("moderator");
    const administrator = await playerWithRole("administrator");
    const { sanctions, hasura, rconService } = service();

    await expect(
      sanctions.sanctionServerPlayer({
        serverId: "server-1",
        steamId: administrator,
        type: "ban",
        sanctionedBySteamId: moderator,
      }),
    ).rejects.toThrow(/equal to or above/);
    await expect(
      sanctions.kickServerPlayer({
        serverId: "server-1",
        steamId: administrator,
        kickedBySteamId: moderator,
      }),
    ).rejects.toThrow(/equal to or above/);

    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(rconService.connect).not.toHaveBeenCalled();
  });

  it("lets the sanction action through for a player below the sanctioner", async () => {
    const moderator = await playerWithRole("moderator");
    const user = await playerWithRole("user");
    const { sanctions, hasura } = service();

    await sanctions.sanctionServerPlayer({
      steamId: user,
      type: "mute",
      sanctionedBySteamId: moderator,
    });

    expect(hasura.mutation).toHaveBeenCalled();
  });

  it("still lets the system ban anyone, VAC auto-bans included", async () => {
    const administrator = await playerWithRole("administrator");

    await sanction(administrator, null);

    expect(await sanctionsOn(administrator)).toBe("1");
  });

  it("refuses a moderator session extending a sanction on an administrator", async () => {
    const moderator = await playerWithRole("moderator");
    const administrator = await playerWithRole("administrator");
    const [{ id }] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO player_sanctions
         (player_steam_id, type, reason, remove_sanction_date)
       VALUES ($1::bigint, 'ban', 'expired', now() - interval '1 day')
       RETURNING id`,
      [administrator],
    );

    await expect(
      runAsUser(postgres, moderator, "moderator", (query) =>
        query(
          "UPDATE player_sanctions SET remove_sanction_date = NULL WHERE id = $1",
          [id],
        ),
      ),
    ).rejects.toThrow(/equal to or above/);

    const [row] = await postgres.query<
      Array<{ remove_sanction_date: Date | null }>
    >("SELECT remove_sanction_date FROM player_sanctions WHERE id = $1", [id]);
    expect(row.remove_sanction_date).not.toBeNull();
  });

  it("lets a moderator session change a sanction on a player below them", async () => {
    const moderator = await playerWithRole("moderator");
    const user = await playerWithRole("user");
    const [{ id }] = await sanction(user, moderator);

    await runAsUser(postgres, moderator, "moderator", (query) =>
      query(
        "UPDATE player_sanctions SET remove_sanction_date = now() + interval '1 day' WHERE id = $1",
        [id],
      ),
    );

    const [row] = await postgres.query<
      Array<{ remove_sanction_date: Date | null }>
    >("SELECT remove_sanction_date FROM player_sanctions WHERE id = $1", [id]);
    expect(row.remove_sanction_date).not.toBeNull();
  });

  it("lets an administrator delete a sanctioner whose old sanctions name a higher role", async () => {
    const administrator = await playerWithRole("administrator");
    const moderator = await playerWithRole("moderator");
    const otherAdministrator = await playerWithRole("administrator");
    const [{ id }] = await sanction(otherAdministrator, null);
    await postgres.query(
      "UPDATE player_sanctions SET sanctioned_by_steam_id = $2::bigint WHERE id = $1",
      [id, moderator],
    );

    await runAsUser(postgres, administrator, "administrator", (query) =>
      query("DELETE FROM players WHERE steam_id = $1::bigint", [moderator]),
    );

    const [row] = await postgres.query<
      Array<{ sanctioned_by_steam_id: string | null }>
    >("SELECT sanctioned_by_steam_id FROM player_sanctions WHERE id = $1", [
      id,
    ]);
    expect(row.sanctioned_by_steam_id).toBeNull();
  });

  const deletedAt = async (id: string) =>
    (
      await postgres.query<Array<{ deleted_at: Date | null }>>(
        "SELECT deleted_at FROM player_sanctions WHERE id = $1",
        [id],
      )
    )[0].deleted_at;

  it("lifting a sanction on a player who has since been promoted takes a role above their new one", async () => {
    const moderator = await playerWithRole("moderator");
    const administrator = await playerWithRole("administrator");
    const user = await playerWithRole("user");
    const [{ id }] = await sanction(user, moderator);
    await postgres.query(
      "UPDATE players SET role = 'tournament_organizer' WHERE steam_id = $1::bigint",
      [user],
    );
    const { sanctions } = service();

    await expect(
      sanctions.unsanctionServerPlayer({
        steamId: user,
        type: "ban",
        sanctionId: id,
        liftedBySteamId: moderator,
      }),
    ).rejects.toThrow(/equal to or above/);
    expect(await deletedAt(id)).toBeNull();

    await sanctions.unsanctionServerPlayer({
      steamId: user,
      type: "ban",
      sanctionId: id,
      liftedBySteamId: administrator,
    });
    expect(await deletedAt(id)).not.toBeNull();
  });

  it("refuses a moderator lifting their own sanction or a fellow moderator's", async () => {
    const administrator = await playerWithRole("administrator");
    const moderator = await playerWithRole("moderator");
    const otherModerator = await playerWithRole("moderator");
    const [{ id }] = await sanction(moderator, administrator, "mute");
    const { sanctions } = service();

    for (const lifter of [moderator, otherModerator]) {
      await expect(
        sanctions.unsanctionServerPlayer({
          steamId: moderator,
          type: "mute",
          liftedBySteamId: lifter,
        }),
      ).rejects.toThrow(/equal to or above/);
    }

    expect(await deletedAt(id)).toBeNull();
  });

  it.each([
    ["deleted_at = now()", "a lift"],
    ["remove_sanction_date = now()", "an early expiry"],
  ])(
    "refuses a moderator session writing %s (%s) on their own sanction",
    async (assignment) => {
      const administrator = await playerWithRole("administrator");
      const moderator = await playerWithRole("moderator");
      const [{ id }] = await sanction(moderator, administrator);

      await expect(
        runAsUser(postgres, moderator, "moderator", (query) =>
          query(`UPDATE player_sanctions SET ${assignment} WHERE id = $1`, [
            id,
          ]),
        ),
      ).rejects.toThrow(/equal to or above/);

      const [row] = await postgres.query<
        Array<{ deleted_at: Date | null; remove_sanction_date: Date | null }>
      >(
        "SELECT deleted_at, remove_sanction_date FROM player_sanctions WHERE id = $1",
        [id],
      );
      expect(row).toEqual({ deleted_at: null, remove_sanction_date: null });
    },
  );

  it("lets an administrator session lift a moderator's sanction", async () => {
    const administrator = await playerWithRole("administrator");
    const moderator = await playerWithRole("moderator");
    const [{ id }] = await sanction(moderator, administrator);

    await runAsUser(postgres, administrator, "administrator", (query) =>
      query("UPDATE player_sanctions SET deleted_at = now() WHERE id = $1", [
        id,
      ]),
    );

    expect(await deletedAt(id)).not.toBeNull();
  });

  it("still lets the system lift and expire a sanction on anyone, VAC auto-bans included", async () => {
    const administrator = await playerWithRole("administrator");
    const [{ id: lifted }] = await sanction(administrator, null);
    const [{ id: expired }] = await sanction(administrator, null, "mute");

    await postgres.query(
      "UPDATE player_sanctions SET deleted_at = now() WHERE id = $1",
      [lifted],
    );
    await postgres.query(
      "UPDATE player_sanctions SET remove_sanction_date = now() WHERE id = $1",
      [expired],
    );

    expect(await deletedAt(lifted)).not.toBeNull();
    const [row] = await postgres.query<
      Array<{ remove_sanction_date: Date | null }>
    >("SELECT remove_sanction_date FROM player_sanctions WHERE id = $1", [
      expired,
    ]);
    expect(row.remove_sanction_date).not.toBeNull();
  });
});
