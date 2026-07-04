import { PostgresService } from "../../src/postgres/postgres.service";
import { Fixtures } from "./fixtures";
import { runAsUser } from "./sql-test-db";

// Tournament-flow builders shared by the tournament specs. All state changes
// run under the organizer's admin session, matching how Hasura delivers them.

export type StageSpec = {
  type: string;
  order: number;
  minTeams: number;
  maxTeams: number;
};

export type BracketRow = {
  id: string;
  round: number;
  match_number: number;
  group: number;
  match_id: string | null;
  tournament_team_id_1: string | null;
  tournament_team_id_2: string | null;
  finished: boolean;
};

export class TournamentFixtures {
  constructor(
    private readonly postgres: PostgresService,
    private readonly fx: Fixtures,
  ) {}

  async createTournament(stages: Array<StageSpec>): Promise<{
    id: string;
    organizer: string;
    stageIds: Array<string>;
  }> {
    const organizer = await this.fx.player();
    const [options] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestA}'
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
    );
    const [tournament] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup') RETURNING id`,
      [this.fx.nextName("cup"), organizer, options.id],
    );
    const stageIds: Array<string> = [];
    for (const stage of stages) {
      const [row] = await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tournament.id, stage.type, stage.order, stage.minTeams, stage.maxTeams],
      );
      stageIds.push(row.id);
    }
    return { id: tournament.id, organizer, stageIds };
  }

  setStatus(
    tournamentId: string,
    organizer: string,
    status: string,
  ): Promise<unknown> {
    return runAsUser(this.postgres, organizer, "admin", (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );
  }

  registerTeam(
    tournamentId: string,
    team: { id: string; owner: string },
  ): Promise<string> {
    return runAsUser(this.postgres, team.owner, "admin", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name)
         SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id`,
        [tournamentId, team.id],
      )) as Array<{ id: string }>;
      return row.id;
    });
  }

  // Registers `teamCount` Wingman-sized teams (owner + one mate) and walks the
  // tournament to Live, at which point stage 1 is seeded and scheduled.
  async launch(
    stages: Array<StageSpec>,
    teamCount: number,
  ): Promise<{ id: string; organizer: string; stageIds: Array<string> }> {
    const tournament = await this.createTournament(stages);
    await this.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < teamCount; i++) {
      await this.registerTeam(tournament.id, await this.fx.team(1));
    }
    await this.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
    await this.setStatus(tournament.id, tournament.organizer, "Live");
    return tournament;
  }

  getBrackets(stageId: string): Promise<Array<BracketRow>> {
    return this.postgres.query<Array<BracketRow>>(
      `SELECT id, round, match_number, "group", match_id,
              tournament_team_id_1, tournament_team_id_2, finished
       FROM tournament_brackets
       WHERE tournament_stage_id = $1
       ORDER BY round, "group", match_number`,
      [stageId],
    );
  }

  winMatch(
    matchId: string,
    lineup: "lineup_1_id" | "lineup_2_id" = "lineup_1_id",
  ): Promise<unknown> {
    return this.postgres.query(
      `UPDATE matches SET winning_lineup_id = ${lineup} WHERE id = $1`,
      [matchId],
    );
  }

  // Wins every unfinished scheduled match of a round, lineup 1 taking it,
  // one at a time so per-match side effects (pool assignment, scheduling the
  // next round) run exactly as they would in production.
  async playRound(stageId: string, round: number): Promise<number> {
    const brackets = await this.postgres.query<Array<{ match_id: string }>>(
      `SELECT match_id FROM tournament_brackets
       WHERE tournament_stage_id = $1 AND round = $2
         AND match_id IS NOT NULL AND finished = false
       ORDER BY match_number`,
      [stageId, round],
    );
    for (const bracket of brackets) {
      await this.winMatch(bracket.match_id);
    }
    return brackets.length;
  }

  async tournamentStatus(id: string): Promise<string> {
    const [row] = await this.postgres.query<Array<{ status: string }>>(
      "SELECT status FROM tournaments WHERE id = $1",
      [id],
    );
    return row.status;
  }

  stageResults(
    stageId: string,
  ): Promise<Array<{ tournament_team_id: string; wins: number; losses: number }>> {
    return this.postgres.query<
      Array<{ tournament_team_id: string; wins: number; losses: number }>
    >(
      `SELECT tournament_team_id, wins, losses FROM v_team_stage_results
       WHERE tournament_stage_id = $1 ORDER BY wins DESC, losses ASC`,
      [stageId],
    );
  }
}
