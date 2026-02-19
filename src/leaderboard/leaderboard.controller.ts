import { BadRequestException, Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { PostgresService } from "src/postgres/postgres.service";
import { CacheService } from "src/cache/cache.service";

const VALID_CATEGORIES = [
  "elo",
  "best_kdr",
  "best_win_rate",
  "highest_hs_pct",
] as const;

type LeaderboardCategory = (typeof VALID_CATEGORIES)[number];

const VALID_MATCH_TYPES = ["Competitive", "Wingman", "Duel"] as const;

const VALID_SORT_FIELDS = [
  "value",
  "secondary_value",
  "tertiary_value",
  "matches_played",
] as const;

const MAX_RESULTS = 500;

interface LeaderboardArgs {
  category: string;
  window_days: number;
  match_type?: string;
  limit?: number;
  offset?: number;
  exclude_tournaments?: boolean;
  sort_by?: string;
  sort_dir?: string;
}

interface LeaderboardEntry {
  __typename: "LeaderboardEntry";
  rank: number;
  player_steam_id: string;
  player_name: string;
  player_avatar_url: string | null;
  player_country: string | null;
  value: number;
  secondary_value: number | null;
  tertiary_value: number | null;
  matches_played: number | null;
}

interface LeaderboardResponse {
  __typename: "LeaderboardResponse";
  entries: LeaderboardEntry[];
  total: number;
}

@Controller("leaderboard")
export class LeaderboardController {
  constructor(
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
  ) {}

  @HasuraAction()
  public async getLeaderboard(
    args: LeaderboardArgs,
  ): Promise<LeaderboardResponse> {
    const {
      category,
      window_days,
      match_type,
      limit: rawLimit,
      offset: rawOffset,
      exclude_tournaments,
      sort_by,
      sort_dir,
    } = args;

    if (!VALID_CATEGORIES.includes(category as LeaderboardCategory)) {
      throw new BadRequestException(
        `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`,
      );
    }

    if (match_type && !VALID_MATCH_TYPES.includes(match_type as any)) {
      throw new BadRequestException(
        `Invalid match_type. Must be one of: ${VALID_MATCH_TYPES.join(", ")}`,
      );
    }

    const limit = Math.min(Math.max(rawLimit || 25, 1), 100);
    const offset = Math.max(rawOffset || 0, 0);
    const excludeTournaments = exclude_tournaments ?? false;

    // Cache the full ranked result set (without pagination) so page changes are instant
    const cacheKey = `leaderboard:${category}:${window_days}:${match_type || "all"}:${excludeTournaments ? "no_tourney" : "all"}`;

    let allRows = await this.cache.remember<LeaderboardEntry[]>(
      cacheKey,
      async () => {
        return this.executeQuery(
          category as LeaderboardCategory,
          window_days,
          match_type || null,
          excludeTournaments,
        );
      },
      300,
    );

    // Apply custom sorting if requested
    if (
      sort_by &&
      VALID_SORT_FIELDS.includes(sort_by as (typeof VALID_SORT_FIELDS)[number])
    ) {
      const dir = sort_dir === "asc" ? 1 : -1;
      const field = sort_by as keyof LeaderboardEntry;
      allRows = [...allRows].sort((a, b) => {
        const aVal = (a[field] as number) ?? 0;
        const bVal = (b[field] as number) ?? 0;
        return (aVal - bVal) * dir;
      });
      // Re-rank after sorting
      allRows = allRows.map((row, index) => ({ ...row, rank: index + 1 }));
    }

    return {
      __typename: "LeaderboardResponse",
      entries: allRows.slice(offset, offset + limit),
      total: allRows.length,
    };
  }

  private async executeQuery(
    category: LeaderboardCategory,
    windowDays: number,
    matchType: string | null,
    excludeTournaments: boolean,
  ): Promise<LeaderboardEntry[]> {
    switch (category) {
      case "elo":
        return this.queryElo(windowDays, matchType, excludeTournaments);
      case "best_kdr":
        return this.queryBestKdr(windowDays, matchType, excludeTournaments);
      case "best_win_rate":
        return this.queryBestWinRate(windowDays, matchType, excludeTournaments);
      case "highest_hs_pct":
        return this.queryHighestHsPct(
          windowDays,
          matchType,
          excludeTournaments,
        );
    }
  }

  private tournamentExclusionFilter(matchIdExpr: string): string {
    return `AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = ${matchIdExpr})`;
  }

  private mapRows(rows: any[]): LeaderboardEntry[] {
    return rows.map(
      (row, index): LeaderboardEntry => ({
        __typename: "LeaderboardEntry",
        rank: index + 1,
        player_steam_id: String(row.steam_id),
        player_name: row.name || "Unknown",
        player_avatar_url: row.avatar_url || null,
        player_country: row.country || null,
        value: Number(row.value),
        secondary_value:
          row.secondary_value != null ? Number(row.secondary_value) : null,
        tertiary_value:
          row.tertiary_value != null ? Number(row.tertiary_value) : null,
        matches_played:
          row.matches_played != null ? Number(row.matches_played) : null,
      }),
    );
  }

  /**
   * Combined ELO query returning:
   *   value = Current ELO
   *   secondary_value = ELO Change (ending - starting ELO)
   *   matches_played = match count
   */
  private async queryElo(
    windowDays: number,
    matchType: string | null,
    excludeTournaments: boolean,
  ): Promise<LeaderboardEntry[]> {
    const params: any[] = [];
    let paramIdx = 1;

    const eloTypeFilter = matchType ? `AND pe.type = $${paramIdx++}` : "";
    if (matchType) params.push(matchType);

    const timeFilter =
      windowDays > 0
        ? `AND pe.created_at >= NOW() - make_interval(days => $${paramIdx++})`
        : "";
    if (windowDays > 0) params.push(windowDays);

    const streakMatchTypeFilter = matchType
      ? `AND mo.type = $${paramIdx++}`
      : "";
    if (matchType) params.push(matchType);

    const streakTimeFilter =
      windowDays > 0
        ? `AND m.ended_at >= NOW() - make_interval(days => $${paramIdx++})`
        : "";
    if (windowDays > 0) params.push(windowDays);

    const streakTournamentFilter = excludeTournaments
      ? this.tournamentExclusionFilter("m.id")
      : "";

    params.push(MAX_RESULTS);
    const limitParam = `$${paramIdx++}`;

    let sql: string;

    if (excludeTournaments) {
      sql = `
        WITH last_elo_raw AS (
          SELECT DISTINCT ON (pe.steam_id)
            pe.steam_id,
            pe.current as raw_current
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
          ORDER BY pe.steam_id, pe.created_at DESC
        ),
        tournament_adj AS (
          SELECT pe.steam_id, SUM(pe.change) as tourney_total
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
            AND EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
          GROUP BY pe.steam_id
        ),
        first_elo AS (
          SELECT DISTINCT ON (pe.steam_id)
            pe.steam_id,
            pe.current - pe.change as starting_elo
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
          ORDER BY pe.steam_id, pe.created_at ASC
        ),
        match_counts AS (
          SELECT pe.steam_id, COUNT(*) as matches_played
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
            ${this.tournamentExclusionFilter("pe.match_id")}
          GROUP BY pe.steam_id
        ),
        win_streak AS (
          SELECT sub.steam_id,
            COALESCE(MIN(CASE WHEN sub.won = 0 THEN sub.rn END) - 1, MAX(sub.rn))::int as streak
          FROM (
            SELECT
              mlp.steam_id,
              CASE WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 1 ELSE 0 END as won,
              ROW_NUMBER() OVER (PARTITION BY mlp.steam_id ORDER BY m.ended_at DESC) as rn
            FROM match_lineup_players mlp
            JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
            JOIN matches m ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
            JOIN match_options mo ON mo.id = m.match_options_id
            WHERE m.status = 'Finished'
              AND mlp.steam_id IS NOT NULL
              AND m.winning_lineup_id IS NOT NULL
              ${streakTimeFilter}
              ${streakMatchTypeFilter}
              ${streakTournamentFilter}
          ) sub
          GROUP BY sub.steam_id
        )
        SELECT
          le.steam_id,
          p.name,
          p.avatar_url,
          p.country,
          le.raw_current - COALESCE(ta.tourney_total, 0) as value,
          (le.raw_current - COALESCE(ta.tourney_total, 0)) - fe.starting_elo as secondary_value,
          COALESCE(ws.streak, 0) as tertiary_value,
          COALESCE(mc.matches_played, 0) as matches_played
        FROM last_elo_raw le
        LEFT JOIN tournament_adj ta ON ta.steam_id = le.steam_id
        JOIN first_elo fe ON fe.steam_id = le.steam_id
        LEFT JOIN match_counts mc ON mc.steam_id = le.steam_id
        LEFT JOIN win_streak ws ON ws.steam_id = le.steam_id
        JOIN players p ON p.steam_id = le.steam_id
        ORDER BY value DESC
        LIMIT ${limitParam}
      `;
    } else {
      sql = `
        WITH last_elo AS (
          SELECT DISTINCT ON (pe.steam_id)
            pe.steam_id,
            pe.current as current_elo
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
          ORDER BY pe.steam_id, pe.created_at DESC
        ),
        first_elo AS (
          SELECT DISTINCT ON (pe.steam_id)
            pe.steam_id,
            pe.current - pe.change as starting_elo
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
          ORDER BY pe.steam_id, pe.created_at ASC
        ),
        match_counts AS (
          SELECT pe.steam_id, COUNT(*) as matches_played
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
          GROUP BY pe.steam_id
        ),
        win_streak AS (
          SELECT sub.steam_id,
            COALESCE(MIN(CASE WHEN sub.won = 0 THEN sub.rn END) - 1, MAX(sub.rn))::int as streak
          FROM (
            SELECT
              mlp.steam_id,
              CASE WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 1 ELSE 0 END as won,
              ROW_NUMBER() OVER (PARTITION BY mlp.steam_id ORDER BY m.ended_at DESC) as rn
            FROM match_lineup_players mlp
            JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
            JOIN matches m ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
            JOIN match_options mo ON mo.id = m.match_options_id
            WHERE m.status = 'Finished'
              AND mlp.steam_id IS NOT NULL
              AND m.winning_lineup_id IS NOT NULL
              ${streakTimeFilter}
              ${streakMatchTypeFilter}
          ) sub
          GROUP BY sub.steam_id
        )
        SELECT
          le.steam_id,
          p.name,
          p.avatar_url,
          p.country,
          le.current_elo as value,
          le.current_elo - fe.starting_elo as secondary_value,
          COALESCE(ws.streak, 0) as tertiary_value,
          mc.matches_played
        FROM last_elo le
        JOIN first_elo fe ON fe.steam_id = le.steam_id
        JOIN match_counts mc ON mc.steam_id = le.steam_id
        LEFT JOIN win_streak ws ON ws.steam_id = le.steam_id
        JOIN players p ON p.steam_id = le.steam_id
        ORDER BY value DESC
        LIMIT ${limitParam}
      `;
    }

    const rows = await this.postgres.query<any[]>(sql, params);
    return this.mapRows(rows);
  }

  private async queryBestKdr(
    windowDays: number,
    matchType: string | null,
    excludeTournaments: boolean,
  ): Promise<LeaderboardEntry[]> {
    const params: any[] = [];
    let paramIdx = 1;

    const killTimeFilter =
      windowDays > 0
        ? `AND pk.time >= NOW() - make_interval(days => $${paramIdx++})`
        : "";
    if (windowDays > 0) params.push(windowDays);

    let killMatchTypeJoin = "";
    let killMatchTypeFilter = "";
    if (matchType) {
      killMatchTypeJoin = `
        JOIN matches m ON m.id = pk.match_id
        JOIN match_options mo ON mo.id = m.match_options_id`;
      killMatchTypeFilter = `AND mo.type = $${paramIdx++}`;
      params.push(matchType);
    }

    const killTournamentFilter = excludeTournaments
      ? this.tournamentExclusionFilter("pk.match_id")
      : "";

    const deathTimeParamIdx = windowDays > 0 ? paramIdx++ : 0;
    if (windowDays > 0) params.push(windowDays);

    let deathMatchTypeJoin = "";
    let deathMatchTypeFilter = "";
    if (matchType) {
      deathMatchTypeJoin = `
        JOIN matches m2 ON m2.id = dk.match_id
        JOIN match_options mo2 ON mo2.id = m2.match_options_id`;
      deathMatchTypeFilter = `AND mo2.type = $${paramIdx++}`;
      params.push(matchType);
    }

    const deathTournamentFilter = excludeTournaments
      ? this.tournamentExclusionFilter("dk.match_id")
      : "";

    params.push(MAX_RESULTS);
    const limitParam = `$${paramIdx++}`;

    const deathTimeFilter =
      windowDays > 0
        ? `AND dk.time >= NOW() - make_interval(days => $${deathTimeParamIdx})`
        : "";

    const sql = `
      WITH kills AS (
        SELECT
          pk.attacker_steam_id as steam_id,
          COUNT(*) as kill_count,
          COUNT(DISTINCT pk.match_id) as match_count
        FROM player_kills pk
        ${killMatchTypeJoin}
        WHERE pk.attacker_steam_id IS NOT NULL
          AND pk.attacker_steam_id != pk.attacked_steam_id
          ${killTimeFilter}
          ${killMatchTypeFilter}
          ${killTournamentFilter}
        GROUP BY pk.attacker_steam_id
      ),
      deaths AS (
        SELECT
          dk.attacked_steam_id as steam_id,
          COUNT(*) as death_count
        FROM player_kills dk
        ${deathMatchTypeJoin}
        WHERE 1=1
          ${deathTimeFilter}
          ${deathMatchTypeFilter}
          ${deathTournamentFilter}
        GROUP BY dk.attacked_steam_id
      )
      SELECT
        k.steam_id,
        p.name,
        p.avatar_url,
        p.country,
        CASE WHEN COALESCE(d.death_count, 0) = 0
          THEN k.kill_count::float
          ELSE ROUND((k.kill_count::numeric / d.death_count::numeric), 2)::float
        END as value,
        k.kill_count as secondary_value,
        COALESCE(d.death_count, 0) as tertiary_value,
        k.match_count as matches_played
      FROM kills k
      LEFT JOIN deaths d ON d.steam_id = k.steam_id
      JOIN players p ON p.steam_id = k.steam_id
      WHERE k.match_count >= 5
      ORDER BY value DESC
      LIMIT ${limitParam}
    `;

    const rows = await this.postgres.query<any[]>(sql, params);
    return this.mapRows(rows);
  }

  /**
   * Win Rate query returning:
   *   value = Win rate %
   *   secondary_value = Wins
   *   tertiary_value = Losses
   *   matches_played = Total matches
   */
  private async queryBestWinRate(
    windowDays: number,
    matchType: string | null,
    excludeTournaments: boolean,
  ): Promise<LeaderboardEntry[]> {
    const params: any[] = [];
    let paramIdx = 1;

    const timeFilter =
      windowDays > 0
        ? `AND m.ended_at >= NOW() - make_interval(days => $${paramIdx++})`
        : "";
    if (windowDays > 0) params.push(windowDays);

    const matchTypeFilter = matchType ? `AND mo.type = $${paramIdx++}` : "";
    if (matchType) params.push(matchType);

    const tournamentFilter = excludeTournaments
      ? this.tournamentExclusionFilter("m.id")
      : "";

    params.push(MAX_RESULTS);
    const limitParam = `$${paramIdx++}`;

    const sql = `
      WITH player_matches AS (
        SELECT
          mlp.steam_id,
          m.id as match_id,
          CASE WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 1 ELSE 0 END as won
        FROM match_lineup_players mlp
        JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        JOIN matches m ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
        JOIN match_options mo ON mo.id = m.match_options_id
        WHERE m.status = 'Finished'
          AND mlp.steam_id IS NOT NULL
          AND m.winning_lineup_id IS NOT NULL
          ${timeFilter}
          ${matchTypeFilter}
          ${tournamentFilter}
      )
      SELECT
        pm.steam_id,
        p.name,
        p.avatar_url,
        p.country,
        ROUND((SUM(pm.won)::numeric / COUNT(*)::numeric) * 100, 2)::float as value,
        SUM(pm.won) as secondary_value,
        COUNT(*) - SUM(pm.won) as tertiary_value,
        COUNT(*) as matches_played
      FROM player_matches pm
      JOIN players p ON p.steam_id = pm.steam_id
      GROUP BY pm.steam_id, p.name, p.avatar_url, p.country
      HAVING COUNT(*) >= 5
      ORDER BY value DESC
      LIMIT ${limitParam}
    `;

    const rows = await this.postgres.query<any[]>(sql, params);
    return this.mapRows(rows);
  }

  private async queryHighestHsPct(
    windowDays: number,
    matchType: string | null,
    excludeTournaments: boolean,
  ): Promise<LeaderboardEntry[]> {
    const params: any[] = [];
    let paramIdx = 1;

    const timeFilter =
      windowDays > 0
        ? `AND pk.time >= NOW() - make_interval(days => $${paramIdx++})`
        : "";
    if (windowDays > 0) params.push(windowDays);

    let matchTypeJoin = "";
    let matchTypeFilter = "";
    if (matchType) {
      matchTypeJoin = `
        JOIN matches m ON m.id = pk.match_id
        JOIN match_options mo ON mo.id = m.match_options_id`;
      matchTypeFilter = `AND mo.type = $${paramIdx++}`;
      params.push(matchType);
    }

    const tournamentFilter = excludeTournaments
      ? this.tournamentExclusionFilter("pk.match_id")
      : "";

    params.push(MAX_RESULTS);
    const limitParam = `$${paramIdx++}`;

    const sql = `
      SELECT
        pk.attacker_steam_id as steam_id,
        p.name,
        p.avatar_url,
        p.country,
        ROUND((SUM(CASE WHEN pk.headshot THEN 1 ELSE 0 END)::numeric / COUNT(*)::numeric) * 100, 2)::float as value,
        COUNT(*) as secondary_value,
        NULL as tertiary_value,
        COUNT(DISTINCT pk.match_id) as matches_played
      FROM player_kills pk
      JOIN players p ON p.steam_id = pk.attacker_steam_id
      ${matchTypeJoin}
      WHERE pk.attacker_steam_id IS NOT NULL
        AND pk.attacker_steam_id != pk.attacked_steam_id
        ${timeFilter}
        ${matchTypeFilter}
        ${tournamentFilter}
      GROUP BY pk.attacker_steam_id, p.name, p.avatar_url, p.country
      HAVING COUNT(*) >= 25
      ORDER BY value DESC
      LIMIT ${limitParam}
    `;

    const rows = await this.postgres.query<any[]>(sql, params);
    return this.mapRows(rows);
  }
}
