import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Organizers may edit a match_options row through any match, tournament, stage
// or bracket pointing at it. Options ids are readable without logging in, so a
// client could point its own stage (or match, bracket, draft) at another
// tournament's options and then edit that tournament's settings.
describe("match options a client points at (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
  ];

  const REFUSAL = /already belong to another match, tournament or draft/;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchOptionsClaimTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199930000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM draft_games");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const asUser = (steamId: string, sql: string, params: Array<unknown>) =>
    runAsUser(postgres, steamId, "user", (query) => query(sql, params));

  const optionsOf = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ match_options_id: string }>>(
      "SELECT match_options_id FROM tournaments WHERE id = $1",
      [tournamentId],
    );
    return row.match_options_id;
  };

  const victimAndAttacker = async () => {
    const victim = await tfx.createTournament(SE4);
    const attacker = await tfx.createTournament(SE4);
    return { victimOptions: await optionsOf(victim.id), attacker };
  };

  describe("a client session", () => {
    it("can't point its stage at another tournament's options", async () => {
      const { victimOptions, attacker } = await victimAndAttacker();

      await expect(
        asUser(
          attacker.organizer,
          "UPDATE tournament_stages SET match_options_id = $2 WHERE id = $1",
          [attacker.stageIds[0], victimOptions],
        ),
      ).rejects.toThrow(REFUSAL);
    });

    it("can't add a stage on another tournament's options", async () => {
      const { victimOptions, attacker } = await victimAndAttacker();

      await expect(
        asUser(
          attacker.organizer,
          `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams, match_options_id)
           VALUES ($1, 'SingleElimination', 2, 2, 2, $2)`,
          [attacker.id, victimOptions],
        ),
      ).rejects.toThrow(REFUSAL);
    });

    it("can't create a tournament on another tournament's options", async () => {
      const { victimOptions, attacker } = await victimAndAttacker();

      await expect(
        asUser(
          attacker.organizer,
          `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
           VALUES ('copy', now() + interval '1 day', $1, $2, 'Setup')`,
          [attacker.organizer, victimOptions],
        ),
      ).rejects.toThrow(REFUSAL);
    });

    it("can't point a bracket at another tournament's options", async () => {
      const { victimOptions, attacker } = await victimAndAttacker();
      await tfx.setStatus(attacker.id, attacker.organizer, "RegistrationOpen");
      const [bracket] = await tfx.getBrackets(attacker.stageIds[0]);

      await expect(
        asUser(
          attacker.organizer,
          "UPDATE tournament_brackets SET match_options_id = $2 WHERE id = $1",
          [bracket.id, victimOptions],
        ),
      ).rejects.toThrow(REFUSAL);
    });

    it("can't create a match on another match's options", async () => {
      const victim = await fx.match();
      const attacker = await fx.player();

      await expect(
        asUser(
          attacker,
          "INSERT INTO matches (match_options_id) VALUES ($1)",
          [victim.options_id],
        ),
      ).rejects.toThrow(REFUSAL);
    });

    it("can't open a draft on another tournament's options", async () => {
      const { victimOptions, attacker } = await victimAndAttacker();

      await expect(
        asUser(
          attacker.organizer,
          `INSERT INTO draft_games (host_steam_id, type, draft_order, status, match_options_id)
           VALUES ($1, 'Competitive', 'Snake', 'Open', $2)`,
          [attacker.organizer, victimOptions],
        ),
      ).rejects.toThrow(REFUSAL);
    });

    it("can still attach options nothing else uses", async () => {
      const { attacker } = await victimAndAttacker();
      const fresh = await fx.matchOptions({ type: "Wingman" });

      await asUser(
        attacker.organizer,
        "UPDATE tournament_stages SET match_options_id = $2 WHERE id = $1",
        [attacker.stageIds[0], fresh],
      );

      const player = await fx.player();
      await asUser(player, "INSERT INTO matches (match_options_id) VALUES ($1)", [
        await fx.matchOptions(),
      ]);
    });

    it("can save a row whose options the backend shares without changing them", async () => {
      const { attacker } = await victimAndAttacker();
      const shared = await fx.matchOptions({ type: "Wingman" });
      await postgres.query(
        "UPDATE tournament_stages SET match_options_id = $2 WHERE id = $1",
        [attacker.stageIds[0], shared],
      );
      await postgres.query(
        `INSERT INTO draft_games (host_steam_id, type, draft_order, status, match_options_id)
         VALUES ($1, 'Competitive', 'Snake', 'Open', $2)`,
        [attacker.organizer, shared],
      );

      await asUser(
        attacker.organizer,
        "UPDATE tournament_stages SET match_options_id = $2, default_best_of = 3 WHERE id = $1",
        [attacker.stageIds[0], shared],
      );
    });
  });

  // The backend makes a scrim's or draft's match on the options it was set up
  // with, so the row is shared on purpose there.
  describe("the backend", () => {
    it("can create a match on a draft's options", async () => {
      const host = await fx.player();
      const options = await fx.matchOptions();
      await postgres.query(
        `INSERT INTO draft_games (host_steam_id, type, draft_order, status, match_options_id)
         VALUES ($1, 'Competitive', 'Snake', 'Open', $2)`,
        [host, options],
      );

      await postgres.query(
        "INSERT INTO matches (match_options_id) VALUES ($1)",
        [options],
      );
      await runAsUser(postgres, host, "admin", (query) =>
        query("INSERT INTO matches (match_options_id) VALUES ($1)", [options]),
      );
    });
  });
});
