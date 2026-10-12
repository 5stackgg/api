import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// tournament_brackets.match_id is ON DELETE SET NULL, so a hard-deleted
// tournament match leaves its bracket slot behind with no match to reset.
// recreate_tournament_bracket_match puts a match back through the normal
// scheduling path and, for a slot that had been won, unwinds what it fed.
describe("recreating an orphaned tournament bracket match (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentBracketMatchRecreateTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199880000000n);
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
  });

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
  ];

  const recreate = async (bracketId: string): Promise<string> => {
    const [row] = await postgres.query<Array<{ match_id: string }>>(
      "SELECT recreate_tournament_bracket_match($1) AS match_id",
      [bracketId],
    );
    return row.match_id;
  };

  const bracket = async (id: string) => {
    const [row] = await postgres.query<
      Array<{
        match_id: string | null;
        finished: boolean;
        tournament_team_id_1: string | null;
        tournament_team_id_2: string | null;
      }>
    >(
      `SELECT match_id, finished, tournament_team_id_1, tournament_team_id_2
         FROM tournament_brackets WHERE id = $1`,
      [id],
    );
    return row;
  };

  const match = async (id: string) => {
    const [row] = await postgres.query<
      Array<{
        status: string;
        winning_lineup_id: string | null;
        scheduled_at: Date | null;
        cancels_at: Date | null;
        lineup_players: string;
      }>
    >(
      `SELECT m.status, m.winning_lineup_id, m.scheduled_at, m.cancels_at,
              (SELECT count(*) FROM match_lineup_players mlp
                 JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
                WHERE ml.match_id = m.id) AS lineup_players
         FROM matches m WHERE m.id = $1`,
      [id],
    );
    return row;
  };

  const semis = async (stageId: string) =>
    (await tfx.getBrackets(stageId)).filter((b) => b.round === 1);

  const finalOf = async (stageId: string) =>
    (await tfx.getBrackets(stageId)).find((b) => b.round === 2)!;

  const tournamentMatchCount = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM matches m
        WHERE EXISTS (
          SELECT 1 FROM match_lineups ml
            JOIN tournament_teams tt ON tt.team_id = ml.team_id
           WHERE ml.id = m.lineup_1_id AND tt.tournament_id = $1
        )`,
      [tournamentId],
    );
    return Number(row.count);
  };

  const minutesFromNow = (date: Date | null) =>
    date ? (date.getTime() - Date.now()) / 60_000 : null;

  const launchScheduledByHand = async (schedulingMode = "auto") => {
    const t = await tfx.createTournament(SE4);
    await postgres.query(
      "UPDATE tournaments SET auto_start = false, scheduling_mode = $2 WHERE id = $1",
      [t.id, schedulingMode],
    );
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(t.id, await fx.team(1));
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
    await tfx.setStatus(t.id, t.organizer, "Live");
    return t;
  };

  it("recreates the match of a slot whose unplayed match was deleted", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);
    expect((await bracket(semi.id)).match_id).toBeNull();

    const matchId = await recreate(semi.id);

    const slot = await bracket(semi.id);
    expect(slot.match_id).toBe(matchId);
    expect(slot.finished).toBe(false);
    expect(slot.tournament_team_id_1).toBe(semi.tournament_team_id_1);
    expect(slot.tournament_team_id_2).toBe(semi.tournament_team_id_2);

    const recreated = await match(matchId);
    expect(recreated.status).toBe("WaitingForCheckIn");
    expect(Number(recreated.lineup_players)).toBe(4);
    expect(minutesFromNow(recreated.cancels_at)).toBeGreaterThan(14);
  });

  it("waits for the scheduled time of a tournament that does not start matches itself", async () => {
    const t = await launchScheduledByHand();
    const [semi] = await semis(t.stageIds[0]);
    expect(semi.match_id).toBeNull();

    await expect(recreate(semi.id)).rejects.toThrow(/not due/);

    await postgres.query(
      "UPDATE tournament_brackets SET scheduled_at = now() + interval '5 minutes' WHERE id = $1",
      [semi.id],
    );
    const matchId = await recreate(semi.id);

    expect((await bracket(semi.id)).match_id).toBe(matchId);
  });

  // An accepted proposal materializes the fixture at once, parked as
  // Scheduled, so it is on both teams' calendars long before kickoff.
  it("brings back a negotiated fixture's match as soon as its time was agreed", async () => {
    const t = await launchScheduledByHand("negotiated");
    const [semi] = await semis(t.stageIds[0]);
    const [proposal] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO league_scheduling_proposals (tournament_bracket_id, proposed_by_steam_id, proposed_time)
       VALUES ($1, $2, now() + interval '3 days') RETURNING id`,
      [semi.id, t.organizer],
    );
    await postgres.query(
      "UPDATE league_scheduling_proposals SET status = 'Accepted' WHERE id = $1",
      [proposal.id],
    );
    const agreed = (await bracket(semi.id)).match_id!;
    expect((await match(agreed)).status).toBe("Scheduled");
    await postgres.query("DELETE FROM matches WHERE id = $1", [agreed]);

    const recreated = await match(await recreate(semi.id));

    expect(recreated.status).toBe("Scheduled");
    expect(minutesFromNow(recreated.scheduled_at)).toBeGreaterThan(
      3 * 24 * 60 - 5,
    );
  });

  it("replays a won slot and unwinds the final it fed", async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    const [semi, otherSemi] = await semis(t.stageIds[0]);
    const finalBefore = await finalOf(t.stageIds[0]);
    expect(finalBefore.match_id).not.toBeNull();

    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);
    expect(await bracket(semi.id)).toMatchObject({
      match_id: null,
      finished: true,
    });

    const matchId = await recreate(semi.id);

    expect(await bracket(semi.id)).toMatchObject({
      match_id: matchId,
      finished: false,
    });
    const recreated = await match(matchId);
    expect(recreated.status).toBe("WaitingForCheckIn");
    expect(recreated.winning_lineup_id).toBeNull();
    expect(minutesFromNow(recreated.cancels_at)).toBeGreaterThan(14);

    const final = await finalOf(t.stageIds[0]);
    expect(final.match_id).toBeNull();
    expect(await match(finalBefore.match_id!)).toBeUndefined();
    const finalTeams = [final.tournament_team_id_1, final.tournament_team_id_2];
    expect(finalTeams.filter((team) => team === null).length).toBe(1);
    expect(finalTeams).toContain(otherSemi.tournament_team_id_1);
  });

  it("refuses a slot that still has its match", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);

    await expect(recreate(semi.id)).rejects.toThrow(/already has a match/);
  });

  it("refuses a won slot whose final is already being played", async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    const [semi] = await semis(t.stageIds[0]);
    const final = await finalOf(t.stageIds[0]);
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1`,
      [final.match_id],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      final.match_id,
    ]);
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);

    await expect(recreate(semi.id)).rejects.toThrow(/downstream/);

    expect(await bracket(semi.id)).toMatchObject({
      match_id: null,
      finished: true,
    });
    expect((await match(final.match_id!)).status).toBe("Live");
  });

  // CancelExpiredMatches cancels a stalled live match, so Canceled alone does
  // not mean nothing was played; its demos would go with it.
  it("refuses a won slot whose final went live before it was canceled", async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    const [semi] = await semis(t.stageIds[0]);
    const final = await finalOf(t.stageIds[0]);
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1`,
      [final.match_id],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      final.match_id,
    ]);
    await postgres.query(
      "UPDATE matches SET status = 'Canceled' WHERE id = $1",
      [final.match_id],
    );
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);

    await expect(recreate(semi.id)).rejects.toThrow(/went live/);

    expect((await match(final.match_id!)).status).toBe("Canceled");
    expect((await bracket(final.id)).match_id).toBe(final.match_id);
  });

  it("still clears a final that was canceled before anyone played it", async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    const [semi] = await semis(t.stageIds[0]);
    const final = await finalOf(t.stageIds[0]);
    await postgres.query(
      "UPDATE matches SET status = 'Canceled' WHERE id = $1",
      [final.match_id],
    );
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);

    await recreate(semi.id);

    expect(await match(final.match_id!)).toBeUndefined();
    expect((await finalOf(t.stageIds[0])).match_id).toBeNull();
  });

  it("refuses a won slot whose downstream match was already played", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 8, maxTeams: 8 }],
      8,
    );
    await tfx.playRound(t.stageIds[0], 1);
    const brackets = await tfx.getBrackets(t.stageIds[0]);
    const quarter = brackets.find((b) => b.round === 1)!;
    const [{ parent_bracket_id }] = await postgres.query<
      Array<{ parent_bracket_id: string }>
    >("SELECT parent_bracket_id FROM tournament_brackets WHERE id = $1", [
      quarter.id,
    ]);
    const semi = brackets.find((b) => b.id === parent_bracket_id)!;
    await tfx.winMatch(semi.match_id!);
    await postgres.query("DELETE FROM matches WHERE id = $1", [
      quarter.match_id,
    ]);

    await expect(recreate(quarter.id)).rejects.toThrow(/downstream/);

    expect((await match(semi.match_id!)).status).toBe("Finished");
    expect(await bracket(semi.id)).toMatchObject({
      match_id: semi.match_id,
      finished: true,
    });
    expect(await bracket(quarter.id)).toMatchObject({
      match_id: null,
      finished: true,
    });
  });

  it("refuses a later round-robin round while the round before is still being played", async () => {
    const t = await tfx.launch(
      [{ type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 }],
      4,
    );
    const roundTwo = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 2,
    )!;
    expect(roundTwo.match_id).toBeNull();

    await expect(recreate(roundTwo.id)).rejects.toThrow(/not due/);

    expect((await bracket(roundTwo.id)).match_id).toBeNull();
  });

  it("refuses while the tournament is paused", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);
    await tfx.setStatus(t.id, t.organizer, "Paused");

    await expect(recreate(semi.id)).rejects.toThrow(/not running/);

    expect((await bracket(semi.id)).match_id).toBeNull();
  });

  // CheckForScheduledTournamentBrackets reads its due slots without a lock, so
  // it can hand schedule_tournament_match a copy from before a match landed.
  it("never gives a slot a second match from a stale copy", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);

    const [{ match_id }] = await postgres.query<Array<{ match_id: string }>>(
      `SELECT schedule_tournament_match(
                jsonb_populate_record(NULL::tournament_brackets, to_jsonb(tb) || '{"match_id": null}')
              ) AS match_id
         FROM tournament_brackets tb WHERE tb.id = $1`,
      [semi.id],
    );

    expect(match_id).toBe(semi.match_id);
    expect((await bracket(semi.id)).match_id).toBe(semi.match_id);
    expect(await tournamentMatchCount(t.id)).toBe(2);
  });

  it("refuses a won slot in a round robin", async () => {
    const t = await tfx.launch(
      [{ type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 }],
      4,
    );
    const [first] = (await tfx.getBrackets(t.stageIds[0])).filter(
      (b) => b.round === 1,
    );
    await tfx.winMatch(first.match_id!);
    await postgres.query("DELETE FROM matches WHERE id = $1", [first.match_id]);

    await expect(recreate(first.id)).rejects.toThrow(/elimination/);
  });

  it("refuses once the tournament is no longer running", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await semis(t.stageIds[0]);
    await postgres.query("DELETE FROM matches WHERE id = $1", [semi.match_id]);
    await tfx.setStatus(t.id, t.organizer, "Cancelled");

    await expect(recreate(semi.id)).rejects.toThrow(/not running/);
  });
});
