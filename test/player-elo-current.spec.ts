import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// players.elo must answer what a read of player_elo answers after every kind
// of write to it: rating, re-rating, voiding, bracketing, season backfills and
// deletes, match deletes and a full rebuild.
describe("player elo after writes", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let stageId: string;
  let players: Array<string>;

  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const TYPES = ["Competitive", "Wingman", "Duel", "Rush"];

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerEloCurrentTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199740000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await fx.region();
    const tournament = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    stageId = tournament.stageIds[0];
    players = await fx.players(4);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_elo");
    await postgres.query("DELETE FROM seasons");
    await fx.enableSeasons(false);
  });

  async function match(): Promise<string> {
    return (await fx.bareMatch()).matchId;
  }

  async function bracket(matchId: string): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_brackets (tournament_stage_id, round, match_number, match_id)
       VALUES ($1, 1, (SELECT coalesce(max(match_number), 0) + 1 FROM tournament_brackets), $2) RETURNING id`,
      [stageId, matchId],
    );
    return row.id;
  }

  // Every player rated on one match in a single statement, as a rating does.
  async function rate(
    matchId: string,
    createdAt: string,
    seasonId: string | null = null,
    type = "Competitive",
  ) {
    await postgres.query(
      `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
       SELECT p.steam_id, $1, $4, 1000 + (p.steam_id % 97) * 3 + extract(epoch FROM $2::timestamptz)::bigint % 89, 0, $2, $3
         FROM unnest($5::bigint[]) AS p(steam_id)`,
      [matchId, createdAt, seasonId, type, players],
    );
  }

  async function expectReadsMatch(label: string) {
    const [{ seasons, season }] = await postgres.query<
      Array<{ seasons: boolean; season: string | null }>
    >("SELECT seasons_enabled() AS seasons, get_active_season() AS season");
    const rows = await postgres.query<
      Array<{ steam_id: string; elo: string; expected: string }>
    >(
      `WITH r AS (
         SELECT pe.steam_id, pe.type, pe.current, pe.created_at, pe.season_id,
                EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id) AS bracketed
           FROM player_elo pe
          WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = pe.match_id AND m.elo_voided)
       ), t(type, key) AS (
         VALUES ('Competitive', 'competitive'), ('Wingman', 'wingman'), ('Duel', 'duel'), ('Rush', 'rush')
       )
       SELECT p.steam_id::text AS steam_id, get_player_elo(p)::text AS elo,
              (SELECT CASE WHEN $2 THEN
                  jsonb_object_agg(t.key, coalesce(
                    (SELECT current FROM r WHERE r.steam_id = p.steam_id AND r.type = t.type AND r.season_id = $3 ORDER BY created_at DESC LIMIT 1),
                    (SELECT current FROM r WHERE r.steam_id = p.steam_id AND r.type = t.type ORDER BY created_at DESC LIMIT 1)))
                  || jsonb_object_agg('tournament_' || t.key,
                    (SELECT current FROM r WHERE r.steam_id = p.steam_id AND r.type = t.type AND r.season_id IS NULL AND r.bracketed ORDER BY created_at DESC LIMIT 1))
                ELSE
                  jsonb_object_agg(t.key,
                    (SELECT current FROM r WHERE r.steam_id = p.steam_id AND r.type = t.type ORDER BY created_at DESC LIMIT 1))
                END FROM t)::text AS expected
         FROM players p
        WHERE p.steam_id = ANY ($1::bigint[])
        ORDER BY p.steam_id`,
      [players, seasons, season],
    );
    expect({ label, rows: rows.map((r) => [r.steam_id, r.elo]) }).toEqual({
      label,
      rows: rows.map((r) => [r.steam_id, r.expected]),
    });
  }

  for (const seasonsOn of [false, true]) {
    describe(seasonsOn ? "with seasons on" : "with seasons off", () => {
      let season: string;
      let ended: string;

      beforeEach(async () => {
        await fx.enableSeasons(seasonsOn);
        ended = await fx.season(ago(400), ago(300));
        season = await fx.season(ago(60), null);
      });

      it("follows ratings, re-ratings, voids and brackets", async () => {
        const m1 = await match();
        const m2 = await match();
        const m3 = await match();
        const m4 = await match();

        await rate(m1, ago(40), season);
        await rate(m2, ago(30));
        await rate(m3, ago(350), ended, "Wingman");
        await rate(m4, ago(20), season, "Duel");
        await expectReadsMatch("rated");

        await postgres.query(
          `DELETE FROM player_elo WHERE match_id = $1 AND type = 'Competitive'`,
          [m2],
        );
        await rate(m2, ago(25));
        await expectReadsMatch("re-rated");

        await postgres.query(
          `UPDATE player_elo SET "current" = "current" + 50 WHERE match_id = $1 AND steam_id = $2`,
          [m1, players[0]],
        );
        await postgres.query(
          "UPDATE player_elo SET created_at = $2 WHERE match_id = $1",
          [m1, ago(10)],
        );
        await expectReadsMatch("updated");

        await postgres.query(
          "UPDATE matches SET elo_voided = true WHERE id = $1",
          [m1],
        );
        await expectReadsMatch("voided");
        await postgres.query(
          "UPDATE matches SET elo_voided = false WHERE id = $1",
          [m1],
        );
        await expectReadsMatch("restored");

        const bracketId = await bracket(m2);
        await expectReadsMatch("bracketed");
        await postgres.query(
          "UPDATE tournament_brackets SET match_id = $2 WHERE id = $1",
          [bracketId, m4],
        );
        await expectReadsMatch("bracket moved");
        await postgres.query(
          "UPDATE tournament_brackets SET match_id = NULL WHERE id = $1",
          [bracketId],
        );
        await expectReadsMatch("unbracketed");
      });

      it("follows a season backfill, a season delete and a match delete", async () => {
        const m1 = await match();
        const m2 = await match();
        const m3 = await match();
        await rate(m1, ago(50));
        await rate(m2, ago(40));
        await rate(m3, ago(5), null, "Rush");
        await expectReadsMatch("before the backfill");

        await postgres.query(
          "UPDATE player_elo SET season_id = $1 WHERE match_id = ANY ($2::uuid[])",
          [season, [m1, m2]],
        );
        await expectReadsMatch("seasons assigned");

        await postgres.query("DELETE FROM player_elo WHERE season_id = $1", [
          season,
        ]);
        await expectReadsMatch("season cleared");
        await rate(m1, ago(50), season);
        await rate(m2, ago(40), season);
        await expectReadsMatch("season rebuilt");

        await postgres.query("DELETE FROM seasons WHERE id = $1", [season]);
        await expectReadsMatch("season deleted");

        await postgres.query("DELETE FROM matches WHERE id = $1", [m2]);
        await expectReadsMatch("match deleted");
      });

      it("follows a full rebuild", async () => {
        const m1 = await match();
        const m2 = await match();
        await rate(m1, ago(30), season);
        await rate(m2, ago(20), null, "Wingman");

        await postgres.query("TRUNCATE TABLE player_elo");
        await expectReadsMatch("truncated");

        await rate(m1, ago(30), season);
        await expectReadsMatch("re-rated after the rebuild");
      });

      it("reads every ladder for a mix of histories", async () => {
        let n = 0;
        for (let k = 0; k < 24; k++) {
          const id = await match();
          if (k % 4 === 1) await bracket(id);
          n++;
          await rate(
            id,
            ago(1 + ((n * 13) % 50)),
            k % 3 === 0 ? season : k % 5 === 0 ? ended : null,
            TYPES[k % 4],
          );
          if (k % 5 === 4) {
            await postgres.query(
              "UPDATE matches SET elo_voided = true WHERE id = $1",
              [id],
            );
          }
        }
        await expectReadsMatch("mixed");
      });
    });
  }
});
