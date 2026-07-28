import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
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

// assign_lobby_parties: 5stack parties are derived in the database from the
// lobby, with no API involvement — and must never overwrite a party the
// importer already resolved from Valve/FACEIT.
describe("lobby parties trigger (SQL-driven)", () => {
  let db3: SqlTestDb;
  let pg3: PostgresService;
  let fx3: Fixtures;

  beforeAll(async () => {
    db3 = await bootMigratedDb("LobbyPartiesTest");
    pg3 = db3.postgres;
    fx3 = new Fixtures(pg3, 76561199500000000n);
    await seedRegionWithServer(pg3, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db3?.stop();
  });

  // tai_lobbies reads the creator off the Hasura session and enrolls them as
  // the accepted captain, so the lobby has to be created as a user.
  const newLobby = async (steamIds: string[]) => {
    const [creator, ...rest] = steamIds;
    const lobbyId = await runAsUser(pg3, creator, "user", async (query) => {
      const [row] = (await query(
        "INSERT INTO lobbies (access) VALUES ('Private') RETURNING id",
      )) as Array<{ id: string }>;
      return row.id;
    });

    for (const steamId of rest) {
      await pg3.query(
        `INSERT INTO lobby_players (lobby_id, steam_id, status)
         VALUES ($1, $2, 'Accepted')
         ON CONFLICT (steam_id, lobby_id) DO UPDATE SET status = 'Accepted'`,
        [lobbyId, steamId],
      );
    }
    return lobbyId;
  };

  const partiesOf = (matchId: string) =>
    pg3.query<
      Array<{
        steam_id: string;
        party_id: string | null;
        party_source: string | null;
      }>
    >(
      `SELECT mlp.steam_id::text AS steam_id, mlp.party_id::text AS party_id, mlp.party_source
         FROM match_lineup_players mlp
         JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE ml.match_id = $1::uuid
        ORDER BY mlp.steam_id`,
      [matchId],
    );

  const lineupsFor = async (matchId: string) =>
    (
      await pg3.query<Array<{ id: string }>>(
        `SELECT id FROM match_lineups WHERE match_id = $1 ORDER BY id`,
        [matchId],
      )
    ).map((r) => r.id);

  const setSource = (matchId: string, source: string) =>
    pg3.query(`UPDATE matches SET source = $2 WHERE id = $1::uuid`, [
      matchId,
      source,
    ]);

  it("stamps the lobby on players who queued together", async () => {
    const duoA = await fx3.player();
    const duoB = await fx3.player();
    const solo = await fx3.player();
    const lobbyId = await newLobby([duoA, duoB]);

    const { matchId } = await fx3.bareMatch();
    const [lineup1] = await lineupsFor(matchId);

    // one bulk insert, the way matchmaking writes a team
    await pg3.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
       SELECT $1, unnest($2::bigint[])`,
      [lineup1, [duoA, duoB, solo]],
    );

    const rows = await partiesOf(matchId);
    const byId = new Map(rows.map((r) => [r.steam_id, r]));
    expect(byId.get(duoA).party_id).toBe(lobbyId);
    expect(byId.get(duoB).party_id).toBe(lobbyId);
    expect(byId.get(duoA).party_source).toBe("lobby");
    // in no lobby -> not a party
    expect(byId.get(solo).party_id).toBeNull();
  });

  it("ignores a lobby whose other members are not in this match", async () => {
    const player = await fx3.player();
    const friendElsewhere = await fx3.player();
    await newLobby([player, friendElsewhere]);

    const { matchId } = await fx3.bareMatch();
    const [lineup1] = await lineupsFor(matchId);
    await pg3.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)`,
      [lineup1, player],
    );

    const [row] = await partiesOf(matchId);
    expect(row.party_id).toBeNull();
  });

  it("refuses to stamp a lobby on an imported match", async () => {
    // Two players who happen to share a 5stack lobby also appear in an
    // imported Valve match. Their lobby says nothing about how they queued
    // for Valve, so it must not be recorded as a party there.
    const a = await fx3.player();
    const b = await fx3.player();
    await newLobby([a, b]);

    const { matchId } = await fx3.bareMatch();
    await setSource(matchId, "valve");
    const [lineup1] = await lineupsFor(matchId);

    await pg3.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
       SELECT $1, unnest($2::bigint[])`,
      [lineup1, [a, b]],
    );

    for (const row of await partiesOf(matchId)) {
      expect(row.party_id).toBeNull();
      expect(row.party_source).toBeNull();
    }
  });

  it("never overwrites a party the importer already resolved", async () => {
    const a = await fx3.player();
    const b = await fx3.player();
    await newLobby([a, b]);

    const { matchId } = await fx3.bareMatch();
    const [lineup1] = await lineupsFor(matchId);
    const [{ id: valveParty }] = await pg3.query<Array<{ id: string }>>(
      "SELECT gen_random_uuid() AS id",
    );

    // the importer stamps valve parties in the same insert
    await pg3.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id, party_id, party_source)
       VALUES ($1, $2, $3::uuid, 'valve'), ($1, $4, $3::uuid, 'valve')`,
      [lineup1, a, valveParty, b],
    );

    for (const row of await partiesOf(matchId)) {
      expect(row.party_id).toBe(valveParty);
      expect(row.party_source).toBe("valve");
    }
  });

  it("keeps one party id when a lobby is split across both lineups", async () => {
    const a = await fx3.player();
    const b = await fx3.player();
    const lobbyId = await newLobby([a, b]);

    const { matchId } = await fx3.bareMatch();
    const [lineup1, lineup2] = await lineupsFor(matchId);

    // separate statements, the way matchmaking writes team 1 then team 2
    await pg3.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)`,
      [lineup1, a],
    );
    await pg3.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)`,
      [lineup2, b],
    );

    const rows = await partiesOf(matchId);
    expect(rows.map((r) => r.party_id)).toEqual([lobbyId, lobbyId]);
  });
});

// syncPartiesForMatch's clear + re-stamp runs raw SQL against the real schema,
// and must leave lobby-derived parties alone.
describe("party-sync clear/re-stamp SQL", () => {
  let db4: SqlTestDb;
  let pg4: PostgresService;
  let fx4: Fixtures;

  beforeAll(async () => {
    db4 = await bootMigratedDb("PartySyncWriteTest");
    pg4 = db4.postgres;
    fx4 = new Fixtures(pg4, 76561199600000000n);
    await seedRegionWithServer(pg4, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db4?.stop();
  });

  const clearForSource = (matchId: string, source: string) =>
    pg4.query(
      `UPDATE public.match_lineup_players mlp
          SET party_id = NULL, party_source = NULL
         FROM public.match_lineups ml
        WHERE ml.id = mlp.match_lineup_id
          AND ml.match_id = $1::uuid
          AND mlp.party_id IS NOT NULL
          AND mlp.party_source = $2`,
      [matchId, source],
    );

  const stamp = (
    matchId: string,
    source: string,
    steamIds: string[],
    partyIds: string[],
  ) =>
    pg4.query<Array<{ steam_id: string }>>(
      `UPDATE public.match_lineup_players mlp
          SET party_id = data.party_id::uuid, party_source = $3
         FROM public.match_lineups ml,
              unnest($2::bigint[], $4::uuid[]) AS data(steam_id, party_id)
        WHERE ml.id = mlp.match_lineup_id
          AND ml.match_id = $1::uuid
          AND mlp.steam_id = data.steam_id
          AND (mlp.party_source IS NULL OR mlp.party_source = $3)
        RETURNING mlp.steam_id`,
      [matchId, steamIds, source, partyIds],
    );

  const rowsOf = (matchId: string) =>
    pg4.query<
      Array<{
        steam_id: string;
        party_id: string | null;
        party_source: string | null;
      }>
    >(
      `SELECT mlp.steam_id::text AS steam_id, mlp.party_id::text AS party_id, mlp.party_source
         FROM match_lineup_players mlp
         JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE ml.match_id = $1::uuid
        ORDER BY mlp.steam_id`,
      [matchId],
    );

  it("re-stamps the source's own parties and clears stale ones", async () => {
    const { matchId } = await fx4.bareMatch();
    const [lineup] = (
      await pg4.query<Array<{ id: string }>>(
        `SELECT id FROM match_lineups WHERE match_id = $1 ORDER BY id`,
        [matchId],
      )
    ).map((r) => r.id);

    const a = await fx4.lineupPlayer(lineup);
    const b = await fx4.lineupPlayer(lineup);
    const dropped = await fx4.lineupPlayer(lineup);

    const [{ old: oldParty }] = await pg4.query<Array<{ old: string }>>(
      "SELECT gen_random_uuid() AS old",
    );
    await stamp(
      matchId,
      "valve",
      [a, b, dropped],
      [oldParty, oldParty, oldParty],
    );

    // a fresh sync: dropped is no longer partied
    const [{ fresh }] = await pg4.query<Array<{ fresh: string }>>(
      "SELECT gen_random_uuid() AS fresh",
    );
    await clearForSource(matchId, "valve");
    await stamp(matchId, "valve", [a, b], [fresh, fresh]);

    const byId = new Map((await rowsOf(matchId)).map((r) => [r.steam_id, r]));
    expect(byId.get(a).party_id).toBe(fresh);
    expect(byId.get(b).party_id).toBe(fresh);
    // stale membership must not survive the re-sync
    expect(byId.get(dropped).party_id).toBeNull();
    expect(byId.get(dropped).party_source).toBeNull();
  });

  it("never clears or overwrites a lobby party", async () => {
    const { matchId } = await fx4.bareMatch();
    const [lineup] = (
      await pg4.query<Array<{ id: string }>>(
        `SELECT id FROM match_lineups WHERE match_id = $1 ORDER BY id`,
        [matchId],
      )
    ).map((r) => r.id);

    const lobbyA = await fx4.lineupPlayer(lineup);
    const lobbyB = await fx4.lineupPlayer(lineup);
    const [{ lobby }] = await pg4.query<Array<{ lobby: string }>>(
      "SELECT gen_random_uuid() AS lobby",
    );
    await stamp(matchId, "lobby", [lobbyA, lobbyB], [lobby, lobby]);

    // a valve sync lands on the same match
    const [{ valve }] = await pg4.query<Array<{ valve: string }>>(
      "SELECT gen_random_uuid() AS valve",
    );
    await clearForSource(matchId, "valve");
    await stamp(matchId, "valve", [lobbyA, lobbyB], [valve, valve]);

    for (const row of await rowsOf(matchId)) {
      expect(row.party_source).toBe("lobby");
      expect(row.party_id).toBe(lobby);
    }
  });
});
