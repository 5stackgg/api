import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises v_player_queue_partners: who queued together, derived from the
// party_id stamped on match_lineup_players by matchmaking (the lobby id) and
// by the external-match importer (a uuid minted per source party).
describe("queue partners (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("QueuePartnersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199300000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_lineups");
    await postgres.query("DELETE FROM players");
  });

  const partyUp = async (
    lineupId: string,
    steamIds: string[],
    partyId: string,
    source = "valve",
  ) => {
    for (const steamId of steamIds) {
      await postgres.query(
        `UPDATE match_lineup_players
            SET party_id = $1::uuid, party_source = $2
          WHERE match_lineup_id = $3 AND steam_id = $4`,
        [partyId, source, lineupId, steamId],
      );
    }
  };

  const finish = async (matchId: string, winningLineupId?: string) => {
    await postgres.query(
      `UPDATE matches SET status = 'Finished', winning_lineup_id = $2 WHERE id = $1`,
      [matchId, winningLineupId ?? null],
    );
  };

  const lineupsOf = async (matchId: string) => {
    const rows = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_lineups WHERE match_id = $1 ORDER BY id`,
      [matchId],
    );
    return rows.map((row) => row.id);
  };

  const partnersOf = (steamId: string) =>
    postgres.query<
      Array<{
        partner_steam_id: string;
        matches_together: number;
        wins_together: number;
      }>
    >(
      `SELECT partner_steam_id, matches_together, wins_together
         FROM v_player_queue_partners
        WHERE steam_id = $1
        ORDER BY matches_together DESC, partner_steam_id`,
      [steamId],
    );

  const newPartyId = async () => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      "SELECT gen_random_uuid() AS id",
    );
    return row.id;
  };

  it("pairs everyone in a party, in both directions", async () => {
    const { matchId } = await fx.bareMatch();
    const [lineup1] = await lineupsOf(matchId);

    const duo = [
      await fx.lineupPlayer(lineup1),
      await fx.lineupPlayer(lineup1),
    ];
    const solo = await fx.lineupPlayer(lineup1);

    await partyUp(lineup1, duo, await newPartyId());
    await finish(matchId);

    expect(await partnersOf(duo[0])).toEqual([
      { partner_steam_id: duo[1], matches_together: 1, wins_together: 0 },
    ]);
    expect(await partnersOf(duo[1])).toEqual([
      { partner_steam_id: duo[0], matches_together: 1, wins_together: 0 },
    ]);
    // the solo queuer shared a lineup but not a party
    expect(await partnersOf(solo)).toEqual([]);
  });

  it("does not pair two different parties in the same lineup", async () => {
    const { matchId } = await fx.bareMatch();
    const [lineup1] = await lineupsOf(matchId);

    const duoA = [
      await fx.lineupPlayer(lineup1),
      await fx.lineupPlayer(lineup1),
    ];
    const duoB = [
      await fx.lineupPlayer(lineup1),
      await fx.lineupPlayer(lineup1),
    ];

    await partyUp(lineup1, duoA, await newPartyId());
    await partyUp(lineup1, duoB, await newPartyId());
    await finish(matchId);

    expect((await partnersOf(duoA[0])).map((r) => r.partner_steam_id)).toEqual([
      duoA[1],
    ]);
  });

  it("counts a party that self-split across both lineups", async () => {
    // a 5stack lobby big enough to fill the whole match is shuffled across
    // both sides — they still queued together
    const { matchId } = await fx.bareMatch();
    const [lineup1, lineup2] = await lineupsOf(matchId);

    const a = await fx.lineupPlayer(lineup1);
    const b = await fx.lineupPlayer(lineup2);

    const lobbyId = await newPartyId();
    await partyUp(lineup1, [a], lobbyId, "lobby");
    await partyUp(lineup2, [b], lobbyId, "lobby");
    await finish(matchId, lineup1);

    expect(await partnersOf(a)).toEqual([
      { partner_steam_id: b, matches_together: 1, wins_together: 1 },
    ]);
    // b was on the losing lineup, so the pair is a loss from b's side
    expect(await partnersOf(b)).toEqual([
      { partner_steam_id: a, matches_together: 1, wins_together: 0 },
    ]);
  });

  it("accumulates across matches and counts wins", async () => {
    const steamA = await fx.player();
    const steamB = await fx.player();
    // a stable 5stack lobby id, reused across matches the way lobbies.id is
    const lobbyId = await newPartyId();

    for (const won of [true, true, false]) {
      const { matchId } = await fx.bareMatch();
      const [lineup1] = await lineupsOf(matchId);
      await fx.lineupPlayer(lineup1, steamA);
      await fx.lineupPlayer(lineup1, steamB);
      await partyUp(lineup1, [steamA, steamB], lobbyId, "lobby");
      await finish(matchId, won ? lineup1 : null);
    }

    expect(await partnersOf(steamA)).toEqual([
      { partner_steam_id: steamB, matches_together: 3, wins_together: 2 },
    ]);
  });

  it("ignores matches that never finished", async () => {
    const { matchId } = await fx.bareMatch();
    const [lineup1] = await lineupsOf(matchId);
    const duo = [
      await fx.lineupPlayer(lineup1),
      await fx.lineupPlayer(lineup1),
    ];
    await partyUp(lineup1, duo, await newPartyId());

    await postgres.query(`UPDATE matches SET status = 'Live' WHERE id = $1`, [
      matchId,
    ]);
    expect(await partnersOf(duo[0])).toEqual([]);

    await postgres.query(
      `UPDATE matches SET status = 'Canceled' WHERE id = $1`,
      [matchId],
    );
    expect(await partnersOf(duo[0])).toEqual([]);
  });
});

// The party-sync lookup runs raw SQL against the real schema; SELECT DISTINCT
// with an ORDER BY over a computed column is a Postgres error, so exercise it.
describe("party-sync player lookup SQL", () => {
  let db2: SqlTestDb;
  let pg2: PostgresService;
  let fx2: Fixtures;

  beforeAll(async () => {
    db2 = await bootMigratedDb("PartySyncLookupTest");
    pg2 = db2.postgres;
    fx2 = new Fixtures(pg2, 76561199400000000n);
    await seedRegionWithServer(pg2, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db2?.stop();
  });

  it("orders linked players first", async () => {
    const { matchId } = await fx2.bareMatch();
    const [lineup1] = (
      await pg2.query<Array<{ id: string }>>(
        `SELECT id FROM match_lineups WHERE match_id = $1 ORDER BY id`,
        [matchId],
      )
    ).map((r) => r.id);

    const unlinked = await fx2.lineupPlayer(lineup1);
    const linked = await fx2.lineupPlayer(lineup1);
    await pg2.query(
      `INSERT INTO player_steam_match_auth (steam_id, auth_code, last_known_share_code)
       VALUES ($1, 'AUTH', 'CSGO-SHARE-CODE')`,
      [linked],
    );

    const rows = await pg2.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT mlp.steam_id::text AS steam_id,
              (psma.steam_id IS NOT NULL) AS linked
         FROM public.match_lineup_players mlp
         JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
         LEFT JOIN public.player_steam_match_auth psma
           ON psma.steam_id = mlp.steam_id
        WHERE ml.match_id = $1::uuid AND mlp.steam_id IS NOT NULL
        ORDER BY linked DESC, steam_id`,
      [matchId],
    );

    expect(rows.map((r) => r.steam_id)).toEqual([linked, unlinked]);
  });
});
