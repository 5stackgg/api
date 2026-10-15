import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { AwardsService } from "./../src/awards/awards.service";
import { AwardsController } from "./../src/awards/awards.controller";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The automatic MVP stays the default and the suggestion; a tournament's
// organizers can replace it with another winning player who played, and every
// pick is kept on record.
describe("organizer MVP pick (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentMvpPickTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199690000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM awards WHERE system_key IS NULL");
  });

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
  ];

  type Cup = {
    id: string;
    organizer: string;
    winner: string;
    loser: string;
    best: string;
    second: string;
    outsider: string;
  };

  const teamMatches = async (tournamentTeamId: string) =>
    (
      await postgres.query<Array<{ match_id: string }>>(
        `SELECT tb.match_id FROM tournament_brackets tb
          WHERE tb.match_id IS NOT NULL
            AND $1 IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
          ORDER BY tb.round`,
        [tournamentTeamId],
      )
    ).map((row) => row.match_id);

  const rosterOf = async (tournamentTeamId: string) =>
    (
      await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id::text FROM tournament_team_roster
          WHERE tournament_team_id = $1 ORDER BY player_steam_id`,
        [tournamentTeamId],
      )
    ).map((row) => row.player_steam_id);

  const placementTeam = async (tournamentId: string, placement: number) => {
    const [row] = await postgres.query<Array<{ tournament_team_id: string }>>(
      `SELECT tournament_team_id FROM tournament_placements($1)
        WHERE placement = $2 LIMIT 1`,
      [tournamentId, placement],
    );
    return row.tournament_team_id;
  };

  const mapOf = async (matchId: string) => {
    const [existing] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_maps WHERE match_id = $1 ORDER BY "order" LIMIT 1`,
      [matchId],
    );
    if (existing) {
      return existing.id;
    }
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [matchId],
    );
    return map.id;
  };

  const mapStats = async (
    steamId: string,
    matchId: string,
    stats: {
      kills?: number;
      hs?: number;
      deaths?: number;
      damage: number;
      rounds: number;
    },
  ) => {
    await postgres.query(
      `INSERT INTO player_match_map_stats
          (steam_id, match_map_id, match_id, kills, hs_kills, deaths, damage, rounds_played)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        steamId,
        await mapOf(matchId),
        matchId,
        stats.kills ?? 0,
        stats.hs ?? 0,
        stats.deaths ?? 0,
        stats.damage,
        stats.rounds,
      ],
    );
  };

  const impact = async (steamId: string, matchId: string, value: number) => {
    await postgres.query(
      `INSERT INTO player_elo (steam_id, match_id, type, "current", change, impact)
        VALUES ($1, $2, 'Wingman', 5000, 0, $3)`,
      [steamId, matchId, value],
    );
  };

  const playOut = async (t: { id: string; stageIds: Array<string> }) => {
    await tfx.playRound(t.stageIds[0], 1);
    await tfx.playRound(t.stageIds[0], 2);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
  };

  // The winner's two players: `best` averages 1.10 over two matches, `second`
  // 1.05. The runner-up's player out-scores both and must never be offered.
  const seedImpacts = async (tournamentId: string): Promise<Cup> => {
    const winner = await placementTeam(tournamentId, 1);
    const loser = await placementTeam(tournamentId, 2);
    const [best, second] = await rosterOf(winner);
    const [outsider] = await rosterOf(loser);
    const [semi, final] = await teamMatches(winner);

    await impact(best, semi, 1.1);
    await impact(best, final, 1.1);
    await impact(second, semi, 1.05);
    await impact(second, final, 1.05);
    await impact(outsider, final, 1.2);

    const [{ organizer_steam_id }] = await postgres.query<
      Array<{ organizer_steam_id: string }>
    >("SELECT organizer_steam_id::text FROM tournaments WHERE id = $1", [
      tournamentId,
    ]);

    return {
      id: tournamentId,
      organizer: organizer_steam_id,
      winner,
      loser,
      best,
      second,
      outsider,
    };
  };

  const finishedCup = async (): Promise<Cup> => {
    const t = await tfx.launch(SE4, 4);
    await playOut(t);
    const cup = await seedImpacts(t.id);
    await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);
    return cup;
  };

  type MvpRow = {
    player_steam_id: string;
    tournament_team_id: string;
    source: string;
    awarded_by_steam_id: string | null;
    note: string | null;
  };

  const mvpRows = async (tournamentId: string) =>
    postgres.query<Array<MvpRow>>(
      `SELECT player_steam_id::text, tournament_team_id, source,
              awarded_by_steam_id::text, note
         FROM award_recipients
        WHERE tournament_id = $1 AND placement = 0`,
      [tournamentId],
    );

  const mvpOf = async (tournamentId: string) => {
    const rows = await mvpRows(tournamentId);
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0]?.player_steam_id ?? null;
  };

  const pick = (
    tournamentId: string,
    steamId: string,
    actor: string,
    note: string | null = null,
  ) =>
    postgres.query<Array<{ set_tournament_mvp: string | null }>>(
      "SELECT set_tournament_mvp($1, $2, $3, $4)",
      [tournamentId, steamId, actor, note],
    );

  type PickRow = {
    player_steam_id: string;
    tournament_team_id: string | null;
    picked_by_steam_id: string | null;
    automatic_steam_id: string | null;
    automatic_impact: number | null;
    player_impact: number | null;
    replaced_steam_id: string | null;
    note: string | null;
  };

  const history = (tournamentId: string) =>
    postgres.query<Array<PickRow>>(
      `SELECT player_steam_id::text, tournament_team_id,
              picked_by_steam_id::text, automatic_steam_id::text,
              automatic_impact::float, player_impact::float,
              replaced_steam_id::text, note
         FROM tournament_mvp_picks
        WHERE tournament_id = $1
        ORDER BY created_at, id`,
      [tournamentId],
    );

  const mvpCount = async (steamId: string) => {
    const [row] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM award_recipients
        WHERE player_steam_id = $1 AND placement = 0`,
      [steamId],
    );
    return Number(row.count);
  };

  const notifyPlayers = jest.fn();

  const controller = () =>
    new AwardsController(
      new AwardsService(
        new Logger("TournamentMvpPickTest"),
        {} as never,
        postgres,
        { notifyPlayers } as never,
      ),
      { getSetting: async () => "administrator" } as never,
    );

  const user = (steam_id: string, role = "user") =>
    ({ steam_id, role }) as never;

  const coOrganize = (tournamentId: string, steamId: string) =>
    postgres.query(
      "INSERT INTO tournament_organizers (tournament_id, steam_id) VALUES ($1, $2)",
      [tournamentId, steamId],
    );

  const setSwitch = (tournamentId: string, steamId: string, value: boolean) =>
    runAsUser(postgres, steamId, "user", (query) =>
      query("UPDATE tournaments SET organizer_picks_mvp = $2 WHERE id = $1", [
        tournamentId,
        value,
      ]),
    );

  const createAward = async (name: string, tier = "special") => {
    const [award] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO awards (name, tier, allow_multiple) VALUES ($1, $2, true) RETURNING id",
      [name, tier],
    );
    return award.id;
  };

  const systemMvpAward = async () => {
    const [award] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM awards WHERE system_key = 'tournament_mvp'",
    );
    return award.id;
  };

  // int8 input accepts every one of these as the same steam id.
  const disguised = (steamId: string) => [
    `0${steamId}`,
    ` ${steamId} `,
    `+${steamId}`,
    `${steamId.slice(0, 5)}_${steamId.slice(5)}`,
    `0x${BigInt(steamId).toString(16)}`,
  ];

  const OUT_OF_RANGE = "9223372036854775808";

  const failure = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the call to fail");
  };

  beforeEach(() => {
    notifyPlayers.mockReset();
  });

  describe("candidates", () => {
    it("ranks the winning team's players who played the way the automatic pick does", async () => {
      const cup = await finishedCup();

      const candidates = await postgres.query<
        Array<{
          player_steam_id: string;
          tournament_team_id: string;
          avg_impact: number;
          matches: number;
          rank: number;
        }>
      >(
        `SELECT player_steam_id::text, tournament_team_id, avg_impact::float,
                matches, rank
           FROM tournament_mvp_candidates($1)
          ORDER BY rank`,
        [cup.id],
      );

      expect(candidates).toEqual([
        {
          player_steam_id: cup.best,
          tournament_team_id: cup.winner,
          avg_impact: expect.closeTo(1.1, 5),
          matches: 2,
          rank: 1,
        },
        {
          player_steam_id: cup.second,
          tournament_team_id: cup.winner,
          avg_impact: expect.closeTo(1.05, 5),
          matches: 2,
          rank: 2,
        },
      ]);
      expect(await mvpOf(cup.id)).toBe(cup.best);
    });

    it("breaks an average tie on total impact", async () => {
      const t = await tfx.launch(SE4, 4);
      await playOut(t);
      const winner = await placementTeam(t.id, 1);
      const [one, two] = await rosterOf(winner);
      const [semi, final] = await teamMatches(winner);
      await impact(one, final, 1.1);
      await impact(two, semi, 1.1);
      await impact(two, final, 1.1);

      const ranked = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id::text FROM tournament_mvp_candidates($1)
          ORDER BY rank`,
        [t.id],
      );
      expect(ranked.map((row) => row.player_steam_id)).toEqual([two, one]);
    });

    it("hands the organizer the ranked list with the stats the picker shows", async () => {
      const cup = await finishedCup();
      const [, final] = await teamMatches(cup.winner);
      await mapStats(cup.best, final, {
        kills: 4,
        hs: 1,
        deaths: 2,
        damage: 360,
        rounds: 4,
      });

      const rows = await controller().tournamentMvpCandidates({
        tournament_id: cup.id,
        user: user(cup.organizer),
      });

      expect(rows.map((row) => row.player_steam_id)).toEqual([
        cup.best,
        cup.second,
      ]);
      expect(rows[0]).toMatchObject({
        rank: 1,
        matches: 2,
        avg_impact: expect.closeTo(1.1, 5),
        adr: 90,
        tournament_team_id: cup.winner,
      });
    });

    it("is only offered to the tournament's organizers", async () => {
      const cup = await finishedCup();
      const siteOrganizer = await fx.player(undefined, "tournament_organizer");

      const error = await failure(
        controller().tournamentMvpCandidates({
          tournament_id: cup.id,
          user: user(siteOrganizer, "tournament_organizer"),
        }),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
    });
  });

  describe("picking", () => {
    it("replaces the automatic MVP and records who picked it, when, and the automatic pick", async () => {
      const cup = await finishedCup();
      expect(await mvpOf(cup.id)).toBe(cup.best);

      await pick(cup.id, cup.second, cup.organizer, "Held B alone");

      expect(await mvpRows(cup.id)).toEqual([
        {
          player_steam_id: cup.second,
          tournament_team_id: cup.winner,
          source: "tournament",
          awarded_by_steam_id: cup.organizer,
          note: "Held B alone",
        },
      ]);
      expect(await history(cup.id)).toEqual([
        {
          player_steam_id: cup.second,
          tournament_team_id: cup.winner,
          picked_by_steam_id: cup.organizer,
          automatic_steam_id: cup.best,
          automatic_impact: expect.closeTo(1.1, 5),
          player_impact: expect.closeTo(1.05, 5),
          replaced_steam_id: cup.best,
          note: "Held B alone",
        },
      ]);
    });

    it("keeps every pick on record while only one MVP is ever granted", async () => {
      const cup = await finishedCup();

      await pick(cup.id, cup.second, cup.organizer);
      await pick(cup.id, cup.best, cup.organizer, "Changed our minds");

      expect(await mvpOf(cup.id)).toBe(cup.best);
      expect(await mvpCount(cup.best)).toBe(1);
      expect(await mvpCount(cup.second)).toBe(0);
      expect(
        (await history(cup.id)).map((row) => [
          row.player_steam_id,
          row.replaced_steam_id,
        ]),
      ).toEqual([
        [cup.second, cup.best],
        [cup.best, cup.second],
      ]);
    });

    it("changes nothing when the pick already holds the MVP with the same note", async () => {
      const cup = await finishedCup();

      await pick(cup.id, cup.second, cup.organizer, "note");
      const [again] = await pick(cup.id, cup.second, cup.organizer, "note");

      expect(again.set_tournament_mvp).toBeNull();
      expect(await history(cup.id)).toHaveLength(1);
    });

    it("caps the note at 140 characters", async () => {
      const cup = await finishedCup();

      const error = await failure(
        pick(cup.id, cup.second, cup.organizer, "x".repeat(141)),
      );
      expect(error.message).toMatch(/140 characters/);

      await pick(cup.id, cup.second, cup.organizer, "x".repeat(140));
      expect(await mvpOf(cup.id)).toBe(cup.second);
    });

    it("survives recalculation, an awards toggle and an admin recalculation", async () => {
      const cup = await finishedCup();
      await pick(cup.id, cup.second, cup.organizer);

      await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);
      expect(await mvpOf(cup.id)).toBe(cup.second);

      await postgres.query(
        "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
        [cup.id],
      );
      expect(await mvpOf(cup.id)).toBeNull();
      await postgres.query(
        "UPDATE tournaments SET awards_enabled = true WHERE id = $1",
        [cup.id],
      );
      expect(await mvpOf(cup.id)).toBe(cup.second);

      await postgres.query("SELECT recalculate_tournament_awards($1)", [
        cup.id,
      ]);
      expect(await mvpOf(cup.id)).toBe(cup.second);
      expect((await mvpRows(cup.id))[0].awarded_by_steam_id).toBe(
        cup.organizer,
      );
    });

    it("goes with the medals when a final is rewound and comes back when it is replayed", async () => {
      const cup = await finishedCup();
      await pick(cup.id, cup.second, cup.organizer);
      const [, final] = await teamMatches(cup.winner);

      await postgres.query(
        "SELECT * FROM reset_tournament_match($1, NULL, 'WaitingForCheckIn', NULL)",
        [final],
      );
      expect(await tfx.tournamentStatus(cup.id)).toBe("Live");
      expect(await mvpOf(cup.id)).toBeNull();

      const [lineups] = await postgres.query<
        Array<{ lineup_1_team: string | null }>
      >(
        `SELECT CASE WHEN tb.tournament_team_id_1 = $2 THEN 'lineup_1_id'
                     ELSE 'lineup_2_id' END AS lineup_1_team
           FROM tournament_brackets tb WHERE tb.match_id = $1`,
        [final, cup.winner],
      );
      await tfx.winMatch(
        final,
        lineups.lineup_1_team as "lineup_1_id" | "lineup_2_id",
      );
      expect(await tfx.tournamentStatus(cup.id)).toBe("Finished");

      expect(await mvpOf(cup.id)).toBe(cup.second);
      expect((await mvpRows(cup.id))[0].awarded_by_steam_id).toBe(
        cup.organizer,
      );
    });

    it("falls back to the automatic pick once the picked player is no longer a candidate", async () => {
      const cup = await finishedCup();
      await pick(cup.id, cup.second, cup.organizer);

      await postgres.query("DELETE FROM player_elo WHERE steam_id = $1", [
        cup.second,
      ]);
      await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);

      expect(await mvpOf(cup.id)).toBe(cup.best);
      expect((await mvpRows(cup.id))[0].awarded_by_steam_id).toBeNull();
      expect(await history(cup.id)).toHaveLength(1);
    });

    it("rejects a player who is not on the winning team or did not play", async () => {
      const cup = await finishedCup();
      const stranger = await fx.player();

      for (const steamId of [cup.outsider, stranger]) {
        const error = await failure(pick(cup.id, steamId, cup.organizer));
        expect(error.message).toMatch(/not one of the winning team's players/);
      }
      expect(await mvpOf(cup.id)).toBe(cup.best);
      expect(await history(cup.id)).toHaveLength(0);
    });

    it("waits for the finish and needs awards on", async () => {
      const t = await tfx.launch(SE4, 4);
      await tfx.playRound(t.stageIds[0], 1);
      const winner = (await tfx.getBrackets(t.stageIds[0])).find(
        (b) => b.round === 2,
      )!.tournament_team_id_1!;
      const [player] = await rosterOf(winner);

      const early = await failure(pick(t.id, player, t.organizer));
      expect(early.message).toMatch(/once the tournament has finished/);

      await tfx.playRound(t.stageIds[0], 2);
      const cup = await seedImpacts(t.id);
      await postgres.query(
        "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
        [cup.id],
      );

      const off = await failure(pick(cup.id, cup.second, cup.organizer));
      expect(off.message).toMatch(/Awards are off/);
    });
  });

  describe("I'll pick the MVP myself", () => {
    it("grants nothing at the finish, and the organizer's pick then applies", async () => {
      const t = await tfx.launch(SE4, 4);
      await postgres.query(
        "UPDATE tournaments SET organizer_picks_mvp = true WHERE id = $1",
        [t.id],
      );
      await playOut(t);
      const finished = await seedImpacts(t.id);
      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);
      expect(await mvpOf(t.id)).toBeNull();

      await pick(t.id, finished.second, finished.organizer);
      expect(await mvpOf(t.id)).toBe(finished.second);
      expect((await history(t.id))[0]).toMatchObject({
        automatic_steam_id: finished.best,
        replaced_steam_id: null,
      });
    });

    it("keeps an MVP already given when turned on after the finish", async () => {
      const cup = await finishedCup();

      await postgres.query(
        "UPDATE tournaments SET organizer_picks_mvp = true WHERE id = $1",
        [cup.id],
      );

      expect(await mvpOf(cup.id)).toBe(cup.best);
    });

    it("keeps that MVP through recalculation, the awards toggle and a replayed final", async () => {
      const cup = await finishedCup();
      await setSwitch(cup.id, cup.organizer, true);
      await postgres.query(
        "UPDATE player_elo SET impact = 1.2 WHERE steam_id = $1",
        [cup.second],
      );

      await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);
      expect(await mvpOf(cup.id)).toBe(cup.best);

      await postgres.query(
        "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
        [cup.id],
      );
      await postgres.query(
        "UPDATE tournaments SET awards_enabled = true WHERE id = $1",
        [cup.id],
      );
      expect(await mvpOf(cup.id)).toBe(cup.best);

      await postgres.query("SELECT recalculate_tournament_awards($1)", [
        cup.id,
      ]);
      expect(await mvpOf(cup.id)).toBe(cup.best);

      const [, final] = await teamMatches(cup.winner);
      const [side] = await postgres.query<Array<{ lineup: string }>>(
        `SELECT CASE WHEN tb.tournament_team_id_1 = $2 THEN 'lineup_1_id'
                     ELSE 'lineup_2_id' END AS lineup
           FROM tournament_brackets tb WHERE tb.match_id = $1`,
        [final, cup.winner],
      );
      await postgres.query(
        "SELECT * FROM reset_tournament_match($1, NULL, 'WaitingForCheckIn', NULL)",
        [final],
      );
      expect(await mvpOf(cup.id)).toBeNull();
      await tfx.winMatch(final, side.lineup as "lineup_1_id" | "lineup_2_id");
      expect(await tfx.tournamentStatus(cup.id)).toBe("Finished");
      expect(await mvpOf(cup.id)).toBe(cup.best);

      expect((await mvpRows(cup.id))[0].awarded_by_steam_id).toBeNull();
      const kept = await postgres.query<
        Array<{
          player_steam_id: string;
          picked_by_steam_id: string | null;
          kept_automatic: boolean;
          replaced_steam_id: string | null;
        }>
      >(
        `SELECT player_steam_id::text, picked_by_steam_id::text,
                kept_automatic, replaced_steam_id::text
           FROM tournament_mvp_picks WHERE tournament_id = $1`,
        [cup.id],
      );
      expect(kept).toEqual([
        {
          player_steam_id: cup.best,
          picked_by_steam_id: cup.organizer,
          kept_automatic: true,
          replaced_steam_id: null,
        },
      ]);
    });

    it("lets the automatic pick move again once the switch is turned back off", async () => {
      const cup = await finishedCup();
      await setSwitch(cup.id, cup.organizer, true);
      await postgres.query(
        "UPDATE player_elo SET impact = 1.2 WHERE steam_id = $1",
        [cup.second],
      );

      await setSwitch(cup.id, cup.organizer, false);

      expect(await mvpOf(cup.id)).toBe(cup.second);
    });

    it("records nothing when turned on over an organizer's pick", async () => {
      const cup = await finishedCup();
      await pick(cup.id, cup.second, cup.organizer);

      await setSwitch(cup.id, cup.organizer, true);
      await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);

      expect(await mvpOf(cup.id)).toBe(cup.second);
      expect(await history(cup.id)).toHaveLength(1);
    });

    it("grants the automatic pick when turned off after a finish without one", async () => {
      const t = await tfx.launch(SE4, 4);
      await postgres.query(
        "UPDATE tournaments SET organizer_picks_mvp = true WHERE id = $1",
        [t.id],
      );
      await playOut(t);
      const cup = await seedImpacts(t.id);
      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);
      expect(await mvpOf(t.id)).toBeNull();

      await postgres.query(
        "UPDATE tournaments SET organizer_picks_mvp = false WHERE id = $1",
        [t.id],
      );

      expect(await mvpOf(t.id)).toBe(cup.best);
    });
  });

  describe("who can pick", () => {
    it("lets the organizer, a co-organizer and an administrator pick, and notifies the new MVP", async () => {
      const cup = await finishedCup();
      const coOrganizer = await fx.player();
      const admin = await fx.player(undefined, "administrator");
      await coOrganize(cup.id, coOrganizer);

      await controller().setTournamentMvp({
        tournament_id: cup.id,
        player_steam_id: cup.second,
        note: null,
        user: user(cup.organizer),
      });
      expect(await mvpOf(cup.id)).toBe(cup.second);
      expect(notifyPlayers).toHaveBeenCalledTimes(1);
      expect(notifyPlayers).toHaveBeenCalledWith(
        "AwardGranted",
        expect.objectContaining({ steamIds: [cup.second] }),
      );

      await controller().setTournamentMvp({
        tournament_id: cup.id,
        player_steam_id: cup.best,
        user: user(coOrganizer),
      });
      expect(await mvpOf(cup.id)).toBe(cup.best);

      await controller().setTournamentMvp({
        tournament_id: cup.id,
        player_steam_id: cup.second,
        user: user(admin, "administrator"),
      });
      expect(await mvpOf(cup.id)).toBe(cup.second);
      expect(
        (await history(cup.id)).map((row) => row.picked_by_steam_id),
      ).toEqual([cup.organizer, coOrganizer, admin]);
    });

    it("does not notify anyone when the pick changes nothing", async () => {
      const cup = await finishedCup();
      const input = {
        tournament_id: cup.id,
        player_steam_id: cup.second,
        user: user(cup.organizer),
      };

      await controller().setTournamentMvp(input);
      await controller().setTournamentMvp(input);

      expect(notifyPlayers).toHaveBeenCalledTimes(1);
    });

    it("refuses site-wide organizers who do not run this tournament, and everyone else", async () => {
      const cup = await finishedCup();
      const siteOrganizer = await fx.player(undefined, "tournament_organizer");
      const moderator = await fx.player(undefined, "moderator");

      for (const actor of [
        user(siteOrganizer, "tournament_organizer"),
        user(moderator, "moderator"),
        user(cup.best),
      ]) {
        const error = await failure(
          controller().setTournamentMvp({
            tournament_id: cup.id,
            player_steam_id: cup.second,
            user: actor,
          }),
        );
        expect(error).toBeInstanceOf(ForbiddenException);
      }
      expect(await mvpOf(cup.id)).toBe(cup.best);
    });

    it("stops an organizer from picking themselves, short of an administrator", async () => {
      const cup = await finishedCup();
      await coOrganize(cup.id, cup.second);

      const error = await failure(
        controller().setTournamentMvp({
          tournament_id: cup.id,
          player_steam_id: cup.second,
          user: user(cup.second),
        }),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(await mvpOf(cup.id)).toBe(cup.best);

      await controller().setTournamentMvp({
        tournament_id: cup.id,
        player_steam_id: cup.second,
        user: user(cup.second, "administrator"),
      });
      expect(await mvpOf(cup.id)).toBe(cup.second);
    });

    it("reports a rule the pick breaks as a bad request", async () => {
      const cup = await finishedCup();

      const error = await failure(
        controller().setTournamentMvp({
          tournament_id: cup.id,
          player_steam_id: cup.outsider,
          user: user(cup.organizer),
        }),
      );
      expect(error).toBeInstanceOf(BadRequestException);
    });

    it("lets only the tournament's own organizers flip the switch through Hasura", async () => {
      const cup = await finishedCup();
      const coOrganizer = await fx.player();
      const siteOrganizer = await fx.player(undefined, "tournament_organizer");
      await coOrganize(cup.id, coOrganizer);

      const flip = (steamId: string, role: string, value: boolean) =>
        runAsUser(postgres, steamId, role, (query) =>
          query(
            "UPDATE tournaments SET organizer_picks_mvp = $2 WHERE id = $1",
            [cup.id, value],
          ),
        );

      await flip(cup.organizer, "user", true);
      await flip(coOrganizer, "user", false);
      await flip(siteOrganizer, "administrator", true);

      const error = await failure(
        flip(siteOrganizer, "tournament_organizer", false),
      );
      expect(error.message).toMatch(/tournament's organizers/);

      const [row] = await postgres.query<
        Array<{ organizer_picks_mvp: boolean }>
      >("SELECT organizer_picks_mvp FROM tournaments WHERE id = $1", [cup.id]);
      expect(row.organizer_picks_mvp).toBe(true);
    });

    it("answers can_pick_mvp for the session the way the actions decide", async () => {
      const cup = await finishedCup();
      const coOrganizer = await fx.player();
      const stranger = await fx.player();
      await coOrganize(cup.id, coOrganizer);

      const canPick = async (steamId: string, role: string) => {
        const [row] = await postgres.query<Array<{ can: boolean }>>(
          `SELECT can_pick_tournament_mvp(t, $2::json) AS can
             FROM tournaments t WHERE t.id = $1`,
          [
            cup.id,
            JSON.stringify({
              "x-hasura-role": role,
              "x-hasura-user-id": steamId,
            }),
          ],
        );
        return row.can;
      };

      expect(await canPick(cup.organizer, "user")).toBe(true);
      expect(await canPick(coOrganizer, "user")).toBe(true);
      expect(await canPick(stranger, "administrator")).toBe(true);
      expect(await canPick(stranger, "tournament_organizer")).toBe(false);
      expect(await canPick(stranger, "user")).toBe(false);
    });
  });

  describe("steam ids", () => {
    it("refuses a steam id written any way but plainly, so an organizer cannot pick themselves", async () => {
      const cup = await finishedCup();
      await coOrganize(cup.id, cup.second);

      for (const steamId of [...disguised(cup.second), OUT_OF_RANGE]) {
        const error = await failure(
          controller().setTournamentMvp({
            tournament_id: cup.id,
            player_steam_id: steamId,
            user: user(cup.second),
          }),
        );
        expect(error).toBeInstanceOf(BadRequestException);
      }
      expect(await mvpOf(cup.id)).toBe(cup.best);
      expect(await history(cup.id)).toHaveLength(0);
    });

    it("refuses the same on a hand grant, so an organizer cannot award themselves", async () => {
      const cup = await finishedCup();
      await coOrganize(cup.id, cup.second);
      const awardId = await createAward("Clutch King");

      for (const steamId of [...disguised(cup.second), OUT_OF_RANGE]) {
        const error = await failure(
          controller().grantAward({
            award_id: awardId,
            player_steam_id: steamId,
            tournament_id: cup.id,
            user: user(cup.second),
          }),
        );
        expect(error).toBeInstanceOf(BadRequestException);
      }

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*) AS count FROM award_recipients WHERE award_id = $1",
        [awardId],
      );
      expect(Number(count)).toBe(0);
    });
  });

  describe("hand grants", () => {
    it("refuses the tournament's MVP award, which only the picker hands out", async () => {
      const cup = await finishedCup();
      const admin = user(
        await fx.player(undefined, "administrator"),
        "administrator",
      );
      const systemMvp = await systemMvpAward();
      const custom = await createAward("Summer Cup MVP", "mvp");
      await postgres.query(
        `INSERT INTO tournament_awards (tournament_id, placement, award_id)
          VALUES ($1, 0, $2)`,
        [cup.id, custom],
      );

      for (const grant of [
        { award_id: systemMvp, tournament_id: cup.id },
        { award_id: systemMvp },
        { award_id: custom, tournament_id: cup.id },
      ]) {
        const error = await failure(
          controller().grantAward({
            ...grant,
            player_steam_id: cup.second,
            user: admin,
          }),
        );
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toMatch(/MVP/);
      }
      expect(await mvpCount(cup.second)).toBe(0);
    });

    it("still hands out an MVP-tier award that is not this tournament's MVP", async () => {
      const cup = await finishedCup();
      const admin = user(
        await fx.player(undefined, "administrator"),
        "administrator",
      );

      await controller().grantAward({
        award_id: await createAward("Community MVP", "mvp"),
        player_steam_id: cup.second,
        tournament_id: cup.id,
        user: admin,
      });

      expect(await mvpCount(cup.second)).toBe(0);
    });
  });

  describe("tournament player stats", () => {
    it("carries ADR from the per-map stats", async () => {
      const cup = await finishedCup();
      const [semi, final] = await teamMatches(cup.winner);

      await mapStats(cup.best, semi, { damage: 300, rounds: 4 });
      await mapStats(cup.best, final, { damage: 100, rounds: 4 });

      const [stats] = await postgres.query<Array<{ adr: number }>>(
        `SELECT adr FROM v_tournament_player_stats
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [cup.id, cup.best],
      );
      expect(stats.adr).toBe(50);
    });
  });
});
