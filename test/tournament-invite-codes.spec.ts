import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// An invite link replaces the typed passcode: it expires, it caps its uses, it
// can be revoked and it records who came in through it. Every one of those is a
// property of the row and the claiming statement rather than of the API, so
// they are exercised against the real schema.
describe("tournament invite codes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  // The action mints, revokes and spends codes on the API's pooled connection,
  // which carries no hasura.user -- there is no trigger behind it, so the
  // controller is the thing under test.
  const controller = () =>
    new TournamentsController(
      new Logger("TournamentInviteCodeTest"),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { notifyPlayers: jest.fn() } as never,
      postgres,
      { getConnection: () => redisStub() } as never,
    );

  // Counting has to be an INCR, so the stub keeps a counter rather than
  // pretending the multi() chain is a no-op.
  const counters = new Map<string, number>();

  const redisStub = () => ({
    multi: () => {
      const queued: Array<[string, unknown]> = [];
      const chain = {
        incr(key: string) {
          const next = (counters.get(key) ?? 0) + 1;
          counters.set(key, next);
          queued.push([key, next]);
          return chain;
        },
        expire() {
          return chain;
        },
        exec: async () => queued.map(([, value]) => [null, value]),
      };
      return chain;
    },
  });

  const asUser = (steamId: string): User => ({
    name: "Player",
    role: "user",
    steam_id: steamId,
  });

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentInviteCodeTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561193700000000n);
    await fx.region("TestCode");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    counters.clear();
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const createTournament = async ({
    columns = { invite_only: true } as Record<
      string,
      string | number | boolean
    >,
  } = {}) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestCode}', 0
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
    );

    const names = Object.keys(columns);
    const extraCols = names.map((name) => `, "${name}"`).join("");
    const extraVals = names.map((_, index) => `, $${index + 4}`).join("");

    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status${extraCols})
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup'${extraVals}) RETURNING id`,
      [
        fx.nextName("cup"),
        organizer,
        options.id,
        ...names.map((name) => columns[name]),
      ],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
    );
    await runAsUser(postgres, organizer, "admin", (query) =>
      query(
        "UPDATE tournaments SET status = 'RegistrationOpen' WHERE id = $1",
        [tournament.id],
      ),
    );

    return { id: tournament.id, organizer };
  };

  const mint = (
    tournamentId: string,
    organizer: string,
    options: { expires_in_minutes?: number; max_uses?: number } = {},
  ) =>
    controller().createTournamentInviteCode({
      user: asUser(organizer),
      tournament_id: tournamentId,
      ...options,
    });

  const redeem = (tournamentId: string, steamId: string, code: string) =>
    controller().redeemTournamentInviteCode({
      user: asUser(steamId),
      tournament_id: tournamentId,
      code,
    });

  const codeRow = async (id: string) => {
    const [row] = await postgres.query<
      Array<{ uses: number; revoked_at: Date | null }>
    >("SELECT uses, revoked_at FROM tournament_invite_codes WHERE id = $1", [
      id,
    ]);
    return row;
  };

  const usedBy = async (inviteCodeId: string) => {
    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id::text AS player_steam_id
         FROM tournament_invite_code_uses
        WHERE invite_code_id = $1
        ORDER BY used_at`,
      [inviteCodeId],
    );
    return rows.map((row) => row.player_steam_id);
  };

  const unlocked = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<{ unlocked: boolean }>>(
      "SELECT tournament_registration_unlocked($1, $2) AS unlocked",
      [tournamentId, steamId],
    );
    return row.unlocked;
  };

  const registerTeam = (tournamentId: string, owner: string) =>
    runAsUser(postgres, owner, "user", (query) =>
      query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, $2, $3, $3)`,
        [tournamentId, fx.nextName("pickup"), owner],
      ),
    );

  const expire = (id: string, interval: string) =>
    postgres.query(
      `UPDATE tournament_invite_codes SET expires_at = now() - $2::interval WHERE id = $1`,
      [id, interval],
    );

  describe("minting", () => {
    it("refuses anyone who does not run the tournament", async () => {
      const t = await createTournament();
      const outsider = await fx.player();

      await expect(mint(t.id, outsider)).rejects.toThrow(
        /not the tournament organizer/i,
      );

      const [row] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*)::text AS count FROM tournament_invite_codes",
      );
      expect(Number(row.count)).toBe(0);
    });

    // A six-digit random() code is enumerable in one pass; the generator is
    // Crockford base32 over gen_random_bytes for exactly that reason.
    it("mints an unguessable code with no ambiguous glyphs", async () => {
      const t = await createTournament();

      const code = await mint(t.id, t.organizer);

      expect(code.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
      expect(code.code).not.toMatch(/[ILOU]/);
    });

    it("keeps generate_utility_invite_code() working off the same generator", async () => {
      const [row] = await postgres.query<Array<{ code: string }>>(
        "SELECT generate_utility_invite_code() AS code",
      );

      expect(row.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    });

    it("refuses to hand out the same code twice", async () => {
      const t = await createTournament();
      const first = await mint(t.id, t.organizer);

      await expect(
        postgres.query(
          `INSERT INTO tournament_invite_codes (tournament_id, created_by_player_steam_id, code)
           VALUES ($1, $2, $3)`,
          [t.id, t.organizer, first.code],
        ),
      ).rejects.toThrow(/duplicate key/i);
    });

    it("does not survive its tournament", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const player = await fx.player();
      await redeem(t.id, player, code.code);

      await postgres.query("DELETE FROM tournaments WHERE id = $1", [t.id]);

      const [row] = await postgres.query<Array<{ count: string }>>(
        `SELECT (SELECT count(*) FROM tournament_invite_codes)
              + (SELECT count(*) FROM tournament_invite_code_uses) AS count`,
      );
      expect(Number(row.count)).toBe(0);
    });
  });

  describe("redeeming", () => {
    it("grants registration and names who spent it", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const player = await fx.player();

      await expect(registerTeam(t.id, player)).rejects.toThrow(/invite only/i);

      await expect(redeem(t.id, player, code.code)).resolves.toEqual({
        success: true,
      });

      expect(await unlocked(t.id, player)).toBe(true);
      expect(await usedBy(code.id)).toEqual([player]);
      expect((await codeRow(code.id)).uses).toBe(1);
      await expect(registerTeam(t.id, player)).resolves.toBeDefined();
    });

    it("is case and whitespace tolerant, because the code is pasted", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const player = await fx.player();

      await expect(
        redeem(t.id, player, `  ${code.code.toLowerCase()} `),
      ).resolves.toEqual({ success: true });
    });

    it("refuses a code that has expired", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer, { expires_in_minutes: 30 });
      const player = await fx.player();
      await expire(code.id, "1 hour");

      await expect(redeem(t.id, player, code.code)).rejects.toThrow(
        /^invite_expired$/,
      );

      expect(await unlocked(t.id, player)).toBe(false);
      expect((await codeRow(code.id)).uses).toBe(0);
    });

    it("keeps working while it is still inside its window", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer, { expires_in_minutes: 30 });
      const player = await fx.player();

      await expect(redeem(t.id, player, code.code)).resolves.toEqual({
        success: true,
      });
    });

    it("refuses a revoked code immediately", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const first = await fx.player();
      const second = await fx.player();
      await redeem(t.id, first, code.code);

      await expect(
        controller().revokeTournamentInviteCode({
          user: asUser(t.organizer),
          invite_code_id: code.id,
        }),
      ).resolves.toEqual({ success: true });

      await expect(redeem(t.id, second, code.code)).rejects.toThrow(
        /^invite_revoked$/,
      );
      expect(await unlocked(t.id, second)).toBe(false);

      // Revoking kills the link, not the record of who already came in.
      expect(await usedBy(code.id)).toEqual([first]);
      expect(await unlocked(t.id, first)).toBe(true);
    });

    it("refuses a revoke from anyone but the organizer", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const outsider = await fx.player();

      await expect(
        controller().revokeTournamentInviteCode({
          user: asUser(outsider),
          invite_code_id: code.id,
        }),
      ).rejects.toThrow(/not the tournament organizer/i);

      expect((await codeRow(code.id)).revoked_at).toBeNull();
    });

    it("refuses once registration has closed", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const player = await fx.player();
      await postgres.query(
        "UPDATE tournaments SET status = 'RegistrationClosed' WHERE id = $1",
        [t.id],
      );

      await expect(redeem(t.id, player, code.code)).rejects.toThrow(
        /^invite_registration_closed$/,
      );
    });

    it("refuses a code minted for a different tournament", async () => {
      const mine = await createTournament();
      const theirs = await createTournament();
      const code = await mint(theirs.id, theirs.organizer);
      const player = await fx.player();

      await expect(redeem(mine.id, player, code.code)).rejects.toThrow(
        /^invite_not_found$/,
      );
      expect(await unlocked(mine.id, player)).toBe(false);
    });

    it("throttles a caller grinding codes at one tournament", async () => {
      const t = await createTournament();
      const player = await fx.player();

      for (
        let i = 0;
        i <= TournamentsController.REDEEM_ATTEMPTS_PER_MINUTE;
        i++
      ) {
        await expect(redeem(t.id, player, "AAAAAAAAAA")).rejects.toThrow();
      }

      await expect(redeem(t.id, player, "AAAAAAAAAA")).rejects.toThrow(
        /^invite_rate_limited$/,
      );
    });

    it("treats a second redemption by the same player as a no-op", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer, { max_uses: 2 });
      const player = await fx.player();

      await redeem(t.id, player, code.code);
      await expect(redeem(t.id, player, code.code)).resolves.toEqual({
        success: true,
      });

      // The second pass must not spend the slot somebody else is owed.
      expect((await codeRow(code.id)).uses).toBe(1);
      expect(await usedBy(code.id)).toEqual([player]);
    });

    // The use row records that the link was spent; the unlock is what actually
    // lets them register, and the two can come apart -- an organizer may delete
    // an unlock. Answering "accepted" off the use row alone left the player
    // holding a spent link and no way in.
    it("re-grants the unlock when the spent link is opened again", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const player = await fx.player();

      await redeem(t.id, player, code.code);

      await postgres.query(
        "DELETE FROM tournament_registration_unlocks WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, player],
      );
      expect(await unlocked(t.id, player)).toBe(false);
      await expect(registerTeam(t.id, player)).rejects.toThrow(/invite only/i);

      await expect(redeem(t.id, player, code.code)).resolves.toEqual({
        success: true,
      });

      expect(await unlocked(t.id, player)).toBe(true);
      await expect(registerTeam(t.id, player)).resolves.toBeDefined();
      // Still one use: re-granting is not a second entry.
      expect((await codeRow(code.id)).uses).toBe(1);
    });
  });

  describe("max_uses", () => {
    // NULL max_uses means unlimited, and `uses < NULL` is NULL rather than
    // true -- so a claim that forgot to special-case it would refuse the very
    // first redemption of an uncapped link while every capped test stayed
    // green.
    it("lets an uncapped link keep going", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const players = await fx.players(4);

      for (const player of players) {
        await expect(redeem(t.id, player, code.code)).resolves.toEqual({
          success: true,
        });
      }

      expect((await codeRow(code.id)).uses).toBe(players.length);
      expect(await usedBy(code.id)).toEqual(players);
    });

    // Same shape one column over: NULL expires_at means never, and
    // `now() < NULL` is NULL, so an expiry check without the null branch
    // rejects a link that was minted to last forever.
    it("lets a link with no expiry keep going", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer);
      const player = await fx.player();

      const [row] = await postgres.query<Array<{ expires_at: Date | null }>>(
        "SELECT expires_at FROM tournament_invite_codes WHERE id = $1",
        [code.id],
      );
      expect(row.expires_at).toBeNull();

      await expect(redeem(t.id, player, code.code)).resolves.toEqual({
        success: true,
      });
      expect(await unlocked(t.id, player)).toBe(true);
    });

    it("stops at the cap", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer, { max_uses: 2 });
      const [first, second, third] = await fx.players(3);

      await expect(redeem(t.id, first, code.code)).resolves.toEqual({
        success: true,
      });
      await expect(redeem(t.id, second, code.code)).resolves.toEqual({
        success: true,
      });
      await expect(redeem(t.id, third, code.code)).rejects.toThrow(
        /^invite_used_up$/,
      );

      expect((await codeRow(code.id)).uses).toBe(2);
      expect(await unlocked(t.id, third)).toBe(false);
    });

    // The claim is one statement so the second UPDATE blocks on the row and
    // then re-checks its own WHERE against the committed `uses`. Held open by
    // hand, because a read-then-write passes this whenever the two happen to
    // serialise on their own.
    it("refuses the last slot to a redemption that was waiting on it", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer, { max_uses: 1 });
      const waiting = await fx.player();

      const holder = await client();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "UPDATE tournament_invite_codes SET uses = uses + 1 WHERE id = $1",
          [code.id],
        );

        const pending = redeem(t.id, waiting, code.code);
        const settled = await blockedOnInviteCodes(pending);
        expect(settled).toBe(false);

        await holder.query("COMMIT");

        await expect(pending).rejects.toThrow(/^invite_used_up$/);
      } finally {
        holder.release();
      }

      expect((await codeRow(code.id)).uses).toBe(1);
      expect(await unlocked(t.id, waiting)).toBe(false);
    });

    it("hands the whole pool out exactly once under a concurrent rush", async () => {
      const t = await createTournament();
      const code = await mint(t.id, t.organizer, { max_uses: 3 });
      const rush = await fx.players(8);

      const results = await Promise.allSettled(
        rush.map((steamId) => redeem(t.id, steamId, code.code)),
      );
      const granted = results.filter(
        (result) => result.status === "fulfilled",
      ).length;

      expect(granted).toBe(3);
      expect((await codeRow(code.id)).uses).toBe(3);
      expect(await usedBy(code.id)).toHaveLength(3);
    });
  });

  describe("pruning", () => {
    it("clears a long dead code nobody ever used", async () => {
      const t = await createTournament();
      const dead = await mint(t.id, t.organizer, { expires_in_minutes: 30 });
      const live = await mint(t.id, t.organizer);
      await expire(dead.id, "2 days");
      const player = await fx.player();

      await redeem(t.id, player, live.code);

      expect(await codeRow(dead.id)).toBeUndefined();
    });

    // Deleting one would cascade the uses away with it, and "see who used it"
    // is the whole point of the audit.
    it("keeps a dead code that somebody came in through", async () => {
      const t = await createTournament();
      const spent = await mint(t.id, t.organizer, {
        expires_in_minutes: 30,
        max_uses: 1,
      });
      const live = await mint(t.id, t.organizer);
      const [first, second] = await fx.players(2);

      await redeem(t.id, first, spent.code);
      await expire(spent.id, "2 days");
      await redeem(t.id, second, live.code);

      expect(await codeRow(spent.id)).toBeDefined();
      expect(await usedBy(spent.id)).toEqual([first]);
    });
  });

  // runAsUser owns the only pooled-client helper the specs have, and it wraps
  // its own transaction; the interleaving test needs to drive BEGIN/COMMIT
  // itself.
  const client = async () => {
    const pool = (
      postgres as unknown as {
        pool: {
          connect(): Promise<{
            query(sql: string, params?: Array<unknown>): Promise<unknown>;
            release(): void;
          }>;
        };
      }
    ).pool;

    return await pool.connect();
  };

  // Resolves false once the claim is provably parked on the row lock, so the
  // interleave is a fact rather than a hope. The pending promise is watched too:
  // a claim that sailed through settles and fails the assertion instead of
  // hanging the suite.
  const blockedOnInviteCodes = async (pending: Promise<unknown>) => {
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );

    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%tournament_invite_codes%'`,
      );

      if (Number(row.count) > 0 || settled) {
        return settled;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw Error("the claim never blocked on the invite code row");
  };
});
