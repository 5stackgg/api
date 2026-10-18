import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";

type KeyValue = string | KeyValues;
type KeyValues = Array<[string, KeyValue]>;

type Token = { type: "string" | "open" | "close"; value: string };

type MatchRow = {
  status: string;
  source: string | null;
  winning_lineup_id: string | null;
  lineup_1_id: string;
  lineup_2_id: string;
  type: string;
  mr: number;
  match_map_id: string | null;
  map_status: string | null;
  map_name: string | null;
  start_lineup_1_side: string | null;
  start_lineup_2_side: string | null;
};

type RoundRow = {
  round: number;
  lineup_1_score: number;
  lineup_2_score: number;
  lineup_1_side: string | null;
  lineup_2_side: string | null;
  winning_side: string | null;
  winning_reason: string | null;
  lineup_1_timeouts_available: number | null;
  lineup_2_timeouts_available: number | null;
  backup_file: string | null;
};

type LineupPlayerRow = {
  steam_id: string | null;
  name: string | null;
  is_connected: boolean;
  match_lineup_id: string;
};

export type RestorePlayer = {
  steam_id: string;
  name: string;
  lineup: number;
  cash: number;
  armor: number;
  helmet: boolean;
  alive: boolean;
  weapons: Array<string>;
  kills: number;
  deaths: number;
  assists: number;
};

export type RestoreRound = {
  round: number;
  lineup_1_score: number;
  lineup_2_score: number;
  lineup_1_side: string | null;
  lineup_2_side: string | null;
  winning_side: string | null;
  winning_reason: string | null;
  lineup_1_timeouts: number | null;
  lineup_2_timeouts: number | null;
  next_lineup_1_side: string | null;
  next_lineup_2_side: string | null;
  has_backup: boolean;
  players: Array<RestorePlayer>;
};

export type RestoreRounds = {
  match_map_id: string | null;
  map_name: string | null;
  restorable: boolean;
  blocked_reason: string | null;
  live_round: number | null;
  economy_hidden: boolean;
  disconnected: Array<string>;
  rounds: Array<RestoreRound>;
};

@Injectable()
export class MatchRecoveryService {
  public static readonly IN_PROGRESS_MAP_STATUSES = [
    "Warmup",
    "Live",
    "Overtime",
    "Paused",
  ];

  public static readonly RESTARTABLE_STATUSES = [
    "WaitingForCheckIn",
    "Veto",
    "WaitingForServer",
    "Live",
  ];

  private static readonly STEAM_ID_BASE = 76561197960265728n;

  private static readonly OVERTIME_MAX_ROUNDS = 6;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly matchAssistant: MatchAssistantService,
  ) {}

  public async getRestoreRounds(
    matchId: string,
    viewerSteamId?: string,
  ): Promise<RestoreRounds> {
    const match = await this.getMatch(matchId);
    const lineupPlayers = await this.getLineupPlayers(match);

    const result: RestoreRounds = {
      match_map_id: match.match_map_id,
      map_name: match.map_name,
      restorable: false,
      blocked_reason: this.restoreBlockedReason(match),
      live_round: null,
      economy_hidden: false,
      disconnected: this.disconnectedNames(lineupPlayers),
      rounds: [],
    };

    if (!match.match_map_id || match.type === "Rush") {
      return result;
    }

    const inProgress = MatchRecoveryService.IN_PROGRESS_MAP_STATUSES.includes(
      match.map_status ?? "",
    );

    result.economy_hidden =
      inProgress &&
      !!viewerSteamId &&
      lineupPlayers.some((player) => player.steam_id === viewerSteamId);

    const rows = await this.getRounds(match.match_map_id);
    const lineupBySteamId = new Map(
      lineupPlayers
        .filter((player) => player.steam_id)
        .map((player) => [
          player.steam_id as string,
          player.match_lineup_id === match.lineup_1_id ? 1 : 2,
        ]),
    );

    result.rounds = rows.map((row, index) => {
      const next = rows[index + 1];
      const hasBackup = !!row.backup_file;

      return {
        round: row.round,
        lineup_1_score: row.lineup_1_score,
        lineup_2_score: row.lineup_2_score,
        lineup_1_side: row.lineup_1_side,
        lineup_2_side: row.lineup_2_side,
        winning_side: row.winning_side,
        winning_reason: row.winning_reason,
        lineup_1_timeouts: row.lineup_1_timeouts_available,
        lineup_2_timeouts: row.lineup_2_timeouts_available,
        next_lineup_1_side:
          next?.lineup_1_side ??
          this.sideForRound(match.start_lineup_1_side, row.round, match),
        next_lineup_2_side:
          next?.lineup_2_side ??
          this.sideForRound(match.start_lineup_2_side, row.round, match),
        has_backup: hasBackup,
        players:
          hasBackup && !result.economy_hidden
            ? this.backupPlayers(row.backup_file as string, lineupBySteamId)
            : [],
      };
    });

    if (inProgress) {
      result.live_round = (rows.at(-1)?.round ?? 0) + 1;
      result.restorable = rows.some((row) => !!row.backup_file);
    }

    return result;
  }

  // `round` is the backup to load: the last round that stays played. Loading
  // round N's backup starts round N + 1.
  public async restoreRound(matchId: string, round: number) {
    const match = await this.getMatch(matchId);

    const blockedReason = this.restoreBlockedReason(match);
    if (blockedReason === "rush") {
      throw Error("Rush matches can't restore rounds");
    }

    if (blockedReason === "not_in_progress") {
      throw Error("there is no map in progress to restore");
    }

    const rows = await this.getRounds(match.match_map_id as string);
    if (!rows.some((row) => row.round === round && !!row.backup_file)) {
      throw Error(`round ${round} has no backup to restore`);
    }

    const disconnected = this.disconnectedNames(
      await this.getLineupPlayers(match),
    );
    if (disconnected.length > 0) {
      throw Error(`waiting for ${disconnected.join(", ")} to reconnect`);
    }

    const response = await this.matchAssistant.requestRoundRestore(
      matchId,
      round,
    );
    if (response === undefined) {
      throw Error("the match server can't be reached");
    }

    this.logger.log(
      `[${matchId}] organizer requested a restore to round ${round}`,
    );

    return { success: true };
  }

  // Cancel, then reopen check-in: what an organizer does by hand with Cancel
  // and Start, in one step. Leaving Canceled is what clears the veto.
  public async restartMatch(matchId: string) {
    const match = await this.getMatch(matchId);

    if (match.source && match.source !== "5stack") {
      throw Error("only matches played on 5stack servers can be restarted");
    }

    const canceled = match.status === "Canceled";

    if (canceled && match.winning_lineup_id) {
      throw Error("this match already has a result");
    }

    if (
      !canceled &&
      !MatchRecoveryService.RESTARTABLE_STATUSES.includes(match.status)
    ) {
      throw Error(`a ${match.status} match can't be restarted`);
    }

    if (!canceled) {
      await this.matchAssistant.updateMatchStatus(matchId, "Canceled");
    }

    await this.matchAssistant.updateMatchStatus(matchId, "WaitingForCheckIn");

    this.logger.log(`[${matchId}] organizer restarted the match`);

    return { success: true };
  }

  public parseKeyValues(text: string): KeyValues {
    const tokens = this.tokenize(text);
    let index = 0;

    const readNode = (): KeyValues => {
      const node: KeyValues = [];
      while (index < tokens.length) {
        const token = tokens[index++];
        if (token.type === "close") {
          return node;
        }
        if (token.type === "open") {
          continue;
        }

        const next = tokens[index];
        if (next?.type === "open") {
          index++;
          node.push([token.value, readNode()]);
          continue;
        }

        index++;
        node.push([token.value, next?.type === "string" ? next.value : ""]);
      }
      return node;
    };

    return readNode();
  }

  private tokenize(text: string): Array<Token> {
    const tokens: Array<Token> = [];
    let i = 0;

    while (i < text.length) {
      const char = text[i];

      if (/\s/.test(char)) {
        i++;
        continue;
      }

      if (char === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") {
          i++;
        }
        continue;
      }

      if (char === "{" || char === "}") {
        tokens.push({ type: char === "{" ? "open" : "close", value: char });
        i++;
        continue;
      }

      if (char === '"') {
        let value = "";
        i++;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === "\\" && i + 1 < text.length) {
            value += text[i + 1];
            i += 2;
            continue;
          }
          value += text[i];
          i++;
        }
        i++;
        tokens.push({ type: "string", value });
        continue;
      }

      let value = "";
      while (i < text.length && !/[\s{}"]/.test(text[i])) {
        value += text[i];
        i++;
      }
      tokens.push({ type: "string", value });
    }

    return tokens;
  }

  private child(node: KeyValues | undefined, key: string) {
    return node?.find(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    )?.[1];
  }

  private childNode(node: KeyValues | undefined, key: string) {
    const value = this.child(node, key);
    return Array.isArray(value) ? value : undefined;
  }

  private childNumber(node: KeyValues | undefined, key: string) {
    const value = Number(this.child(node, key));
    return Number.isFinite(value) ? value : 0;
  }

  private backupPlayers(
    backupFile: string,
    lineupBySteamId: Map<string, number>,
  ): Array<RestorePlayer> {
    const save = this.childNode(this.parseKeyValues(backupFile), "SaveFile");
    const players: Array<RestorePlayer> = [];

    for (const team of ["PlayersOnTeam1", "PlayersOnTeam2"]) {
      for (const [accountId, value] of this.childNode(save, team) ?? []) {
        if (!Array.isArray(value) || !/^\d+$/.test(accountId)) {
          continue;
        }

        const steamId = (
          BigInt(accountId) + MatchRecoveryService.STEAM_ID_BASE
        ).toString();
        const weapons = (this.childNode(value, "Items") ?? [])
          .map(([, item]) => (typeof item === "string" ? item : ""))
          .filter(
            (item) =>
              item &&
              !item.startsWith("weapon_knife") &&
              item !== "weapon_bayonet",
          );

        players.push({
          steam_id: steamId,
          name: String(this.child(value, "name") ?? ""),
          lineup: lineupBySteamId.get(steamId) ?? 0,
          cash: this.childNumber(value, "cash"),
          armor: this.childNumber(value, "armor"),
          helmet: this.child(value, "helmet") === "1",
          alive: !!this.childNode(value, "Items"),
          weapons,
          kills: this.childNumber(value, "kills"),
          deaths: this.childNumber(value, "deaths"),
          assists: this.childNumber(value, "assists"),
        });
      }
    }

    return players;
  }

  // Mirrors the game server's TeamUtility.GetLineupSide: `roundIndex` counts
  // rounds already played, overtime switches every half of
  // mp_overtime_maxrounds.
  private sideForRound(
    startSide: string | null,
    roundIndex: number,
    match: MatchRow,
  ): string | null {
    const mr = Number(match.mr);
    if (!startSide || mr <= 0 || match.type === "Rush") {
      return startSide;
    }

    const opposite = startSide === "CT" ? "TERRORIST" : "CT";

    if (roundIndex < mr * 2) {
      return roundIndex < mr ? startSide : opposite;
    }

    const overtimeMr = MatchRecoveryService.OVERTIME_MAX_ROUNDS;
    const overtimeRound = roundIndex - mr * 2;
    const overtimeNumber = Math.floor(overtimeRound / overtimeMr) + 1;
    const block = overtimeRound % overtimeMr;

    return (
      overtimeNumber % 2 === 1
        ? block < overtimeMr / 2
        : block >= overtimeMr / 2
    )
      ? opposite
      : startSide;
  }

  private restoreBlockedReason(match: MatchRow): string | null {
    if (match.type === "Rush") {
      return "rush";
    }

    if (
      match.status !== "Live" ||
      !MatchRecoveryService.IN_PROGRESS_MAP_STATUSES.includes(
        match.map_status ?? "",
      )
    ) {
      return "not_in_progress";
    }

    return null;
  }

  private disconnectedNames(players: Array<LineupPlayerRow>) {
    return players
      .filter((player) => player.steam_id && !player.is_connected)
      .map((player) => player.name || (player.steam_id as string));
  }

  private async getMatch(matchId: string): Promise<MatchRow> {
    const [match] = await this.postgres.query<Array<MatchRow>>(
      `SELECT m.status, m.source, m.winning_lineup_id::text AS winning_lineup_id,
              m.lineup_1_id::text AS lineup_1_id, m.lineup_2_id::text AS lineup_2_id,
              mo.type, mo.mr,
              mm.id::text AS match_map_id, mm.status AS map_status,
              mm.lineup_1_side AS start_lineup_1_side,
              mm.lineup_2_side AS start_lineup_2_side,
              mp.name AS map_name
         FROM matches m
         JOIN match_options mo ON mo.id = m.match_options_id
         LEFT JOIN match_maps mm ON mm.id = get_current_match_map(m)
         LEFT JOIN maps mp ON mp.id = mm.map_id
        WHERE m.id = $1`,
      [matchId],
    );

    if (!match) {
      throw Error("match not found");
    }

    return match;
  }

  private getRounds(matchMapId: string) {
    return this.postgres.query<Array<RoundRow>>(
      `SELECT round, lineup_1_score, lineup_2_score, lineup_1_side, lineup_2_side,
              winning_side, winning_reason,
              lineup_1_timeouts_available, lineup_2_timeouts_available,
              backup_file
         FROM match_map_rounds
        WHERE match_map_id = $1
          AND round > 0
          AND deleted_at IS NULL
        ORDER BY round`,
      [matchMapId],
    );
  }

  private getLineupPlayers(match: MatchRow) {
    return this.postgres.query<Array<LineupPlayerRow>>(
      `SELECT mlp.steam_id::text AS steam_id,
              COALESCE(p.name, mlp.placeholder_name) AS name,
              mlp.is_connected,
              mlp.match_lineup_id::text AS match_lineup_id
         FROM match_lineup_players mlp
         LEFT JOIN players p ON p.steam_id = mlp.steam_id
        WHERE mlp.match_lineup_id IN ($1, $2)
        ORDER BY mlp.match_lineup_id, name`,
      [match.lineup_1_id, match.lineup_2_id],
    );
  }
}
