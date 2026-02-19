import { BadRequestException, Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { PostgresService } from "src/postgres/postgres.service";
import { CacheService } from "src/cache/cache.service";

const VALID_CATEGORIES = [
  "highest_elo",
  "most_elo_gained",
  "most_kills",
  "best_kdr",
  "best_win_rate",
  "most_matches",
  "highest_hs_pct",
] as const;

type LeaderboardCategory = (typeof VALID_CATEGORIES)[number];

const VALID_MATCH_TYPES = ["Competitive", "Wingman", "Duel"] as const;

const MAX_RESULTS = 500;

interface LeaderboardArgs {
  category: string;
  window_days: number;
  match_type?: string;
  limit?: number;
  offset?: number;
  exclude_tournaments?: boolean;
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

    const allRows = await this.cache.remember<LeaderboardEntry[]>(
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
      case "highest_elo":
        return this.queryHighestElo(windowDays, matchType, excludeTournaments);
      case "most_elo_gained":
        return this.queryMostEloGained(
          windowDays,
          matchType,
          excludeTournaments,
        );
      case "most_kills":
        return this.queryMostKills(windowDays, matchType, excludeTournaments);
      case "best_kdr":
        return this.queryBestKdr(windowDays, matchType, excludeTournaments);
      case "best_win_rate":
        return this.queryBestWinRate(windowDays, matchType, excludeTournaments);
      case "most_matches":
        return this.queryMostMatches(windowDays, matchType, excludeTournaments);
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
        matches_played:
          row.matches_played != null ? Number(row.matches_played) : null,
      }),
    );
  }

  private async queryHighestElo(
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

    params.push(MAX_RESULTS);
    const limitParam = `$${paramIdx++}`;

    let sql: string;

    if (excludeTournaments) {
      // pe.current is cumulative and includes tournament effects, so we can't
      // simply filter records. Instead: get the latest ELO per player, then
      // subtract the SUM of tournament-match ELO changes to approximate what
      // each player's rating would be without tournament matches.
      sql = `
        WITH latest AS (
          SELECT DISTINCT ON (pe.steam_id)
            pe.steam_id,
            pe.current,
            pe.change,
            pe.type
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
          ORDER BY pe.steam_id, pe.created_at DESC
        ),
        tournament_adj AS (
          SELECT pe.steam_id, pe.type, SUM(pe.change) as tourney_total
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
            AND EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
          GROUP BY pe.steam_id, pe.type
        )
        SELECT
          l.steam_id,
          p.name,
          p.avatar_url,
          p.country,
          l.current - COALESCE(ta.tourney_total, 0) as value,
          l.change as secondary_value,
          NULL as matches_played
        FROM latest l
        JOIN players p ON p.steam_id = l.steam_id
        LEFT JOIN tournament_adj ta ON ta.steam_id = l.steam_id AND ta.type = l.type
        ORDER BY value DESC
        LIMIT ${limitParam}
      `;
    } else {
      sql = `
        WITH latest_elo AS (
          SELECT DISTINCT ON (pe.steam_id)
            pe.steam_id,
            pe.current as value,
            pe.change as secondary_value
          FROM player_elo pe
          WHERE 1=1
            ${eloTypeFilter}
            ${timeFilter}
          ORDER BY pe.steam_id, pe.created_at DESC
        )
        SELECT
          le.steam_id,
          p.name,
          p.avatar_url,
          p.country,
          le.value,
          le.secondary_value,
          NULL as matches_played
        FROM latest_elo le
        JOIN players p ON p.steam_id = le.steam_id
        ORDER BY le.value DESC
        LIMIT ${limitParam}
      `;
    }

    const rows = await this.postgres.query<any[]>(sql, params);
    return this.mapRows(rows);
  }

  private async queryMostEloGained(
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

    const tournamentFilter = excludeTournaments
      ? this.tournamentExclusionFilter("pe.match_id")
      : "";

    params.push(MAX_RESULTS);
    const limitParam = `$${paramIdx++}`;

    const sql = `
      SELECT
        pe.steam_id,
        p.name,
        p.avatar_url,
        p.country,
        SUM(pe.change) as value,
        NULL as secondary_value,
        COUNT(*) as matches_played
      FROM player_elo pe
      JOIN players p ON p.steam_id = pe.steam_id
      WHERE 1=1
        ${eloTypeFilter}
        ${timeFilter}
        ${tournamentFilter}
      GROUP BY pe.steam_id, p.name, p.avatar_url, p.country
      HAVING COUNT(*) >= 5
      ORDER BY value DESC
      LIMIT ${limitParam}
    `;

    const rows = await this.postgres.query<any[]>(sql, params);
    return this.mapRows(rows);
  }

  private async queryMostKills(
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
        COUNT(*) as value,
        NULL as secondary_value,
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
      ORDER BY value DESC
      LIMIT ${limitParam}
    `;

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

  private async queryMostMatches(
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
      SELECT
        mlp.steam_id,
        p.name,
        p.avatar_url,
        p.country,
        COUNT(DISTINCT m.id) as value,
        NULL as secondary_value,
        NULL as matches_played
      FROM match_lineup_players mlp
      JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
      JOIN matches m ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
      JOIN match_options mo ON mo.id = m.match_options_id
      JOIN players p ON p.steam_id = mlp.steam_id
      WHERE m.status = 'Finished'
        AND mlp.steam_id IS NOT NULL
        ${timeFilter}
        ${matchTypeFilter}
        ${tournamentFilter}
      GROUP BY mlp.steam_id, p.name, p.avatar_url, p.country
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
