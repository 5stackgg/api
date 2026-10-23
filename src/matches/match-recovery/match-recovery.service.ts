import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";

type KeyValue = string | KeyValues;
type KeyValues = Array<[string, KeyValue]>;

type Token = { type: "string" | "open" | "close"; value: string };

type MatchRow = {
  status: string;
  server_id: string | null;
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
  undone: boolean;
};

export type RecoveryViewer = {
  steam_id: string;
  role: e_player_roles_enum;
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
  undone: boolean;
  players: Array<RestorePlayer>;
};

export type RestoreRounds = {
  match_map_id: string | null;
  map_name: string | null;
  restorable: boolean;
  blocked_reason: string | null;
  live_round: number | null;
  economy_hidden: boolean;
  connected_players: number;
  expected_players: number;
  disconnected: Array<string>;
  rounds: Array<RestoreRound>;
};

@Injectable()
export class MatchRecoveryService {
  public static readonly IN_PROGRESS_MAP_STATUSES = [
    "Warmup",
    "Knife",
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

  // The game server's MatchOptions.ExpectedPlayerCount: it refuses a restore
  // until this many players are in, and benched substitutes don't count.
  private static readonly EXPECTED_PLAYERS: Record<string, number> = {
    Rush: 6,
    Wingman: 4,
    Duel: 2,
  };

  private static readonly RESTORE_REFUSED = "restore_round refused:";

  private static readonly MATCH_STATE_REFUSED = "match_state refused:";

  private static readonly STEAM_ID_BASE = 76561197960265728n;

  private static readonly OVERTIME_MAX_ROUNDS = 6;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly matchAssistant: MatchAssistantService,
  ) {}

  public async getRestoreRounds(
    matchId: string,
    viewer: RecoveryViewer,
  ): Promise<RestoreRounds> {
    const match = await this.getMatch(matchId);
    const lineupPlayers = await this.getLineupPlayers(match);
    const affiliated = await this.isTeamAffiliated(match, viewer.steam_id);

    const result: RestoreRounds = {
      match_map_id: match.match_map_id,
      map_name: match.map_name,
      restorable: false,
      blocked_reason: this.restoreBlockedReason(match, viewer, affiliated),
      live_round: null,
      economy_hidden: false,
      connected_players: this.connectedCount(lineupPlayers),
      expected_players: this.expectedPlayers(match),
      disconnected: this.disconnectedNames(lineupPlayers),
      rounds: [],
    };

    if (!match.match_map_id || match.type === "Rush") {
      return result;
    }

    const inProgress = MatchRecoveryService.IN_PROGRESS_MAP_STATUSES.includes(
      match.map_status ?? "",
    );

    result.economy_hidden = inProgress && affiliated;

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
        undone: row.undone,
        players:
          hasBackup && !result.economy_hidden
            ? this.backupPlayers(row.backup_file as string, lineupBySteamId)
            : [],
      };
    });

    // Rounds a reset undid stay listed, and restorable, until the next round
    // is played and ScoreEvent removes them.
    if (inProgress) {
      result.live_round =
        (rows.filter((row) => !row.undone).at(-1)?.round ?? 0) + 1;
      result.restorable = rows.some((row) => !!row.backup_file);
    }

    return result;
  }

  // `round` is the backup to load: the last round that stays played. Loading
  // round N's backup starts round N + 1.
  public async restoreRound(
    matchId: string,
    round: number,
    viewer: RecoveryViewer,
  ) {
    const match = await this.getMatch(matchId);

    const blockedReason = this.restoreBlockedReason(
      match,
      viewer,
      await this.isTeamAffiliated(match, viewer.steam_id),
    );
    if (blockedReason === "rush") {
      throw Error("Rush matches can't restore rounds");
    }

    if (blockedReason === "not_in_progress") {
      throw Error("there is no map in progress to restore");
    }

    if (blockedReason === "team_member") {
      throw Error(
        "organizers on one of the teams can't restore rounds; players can still call the in-game vote",
      );
    }

    if (blockedReason === "not_live_yet") {
      throw Error("the map isn't live yet; restore once it is");
    }

    const rows = await this.getRounds(match.match_map_id as string);
    if (!rows.some((row) => row.round === round && !!row.backup_file)) {
      throw Error(`round ${round} has no backup to restore`);
    }

    const lineupPlayers = await this.getLineupPlayers(match);
    const connected = this.connectedCount(lineupPlayers);
    const expected = this.expectedPlayers(match);
    if (connected < expected) {
      throw Error(
        `waiting for players to reconnect (${connected}/${expected}): ${this.disconnectedNames(lineupPlayers).join(", ")}`,
      );
    }

    const response = await this.matchAssistant.requestRoundRestore(
      matchId,
      round,
    );
    if (response === undefined) {
      throw Error("the match server can't be reached");
    }

    const refusal = this.serverRefusal(
      response,
      MatchRecoveryService.RESTORE_REFUSED,
    );
    if (refusal) {
      throw Error(refusal);
    }

    this.logger.log(
      `[${matchId}] organizer requested a restore to round ${round}`,
    );

    return { success: true };
  }

  // A veto rewound after a server was booted releases it; a dedicated server
  // keeps running, so it is told to reload and drop the old maps.
  public async rewindMapVeto(
    matchId: string,
    step: number,
    expectedPicks?: number,
  ) {
    const [{ server_id }] = await this.postgres.query<
      Array<{ server_id: string | null }>
    >("SELECT rewind_map_veto($1, $2, $3)::text AS server_id", [
      matchId,
      step,
      expectedPicks ?? null,
    ]);

    if (server_id) {
      await this.matchAssistant.refreshServerMatch(server_id);
    }

    this.logger.log(`[${matchId}] organizer rewound the veto to step ${step}`);

    return { success: true };
  }

  public async extendVetoClock(matchId: string, seconds: number) {
    await this.postgres.query("SELECT extend_veto_clock($1, $2)", [
      matchId,
      seconds,
    ]);

    return { success: true };
  }

  public async extendMatchAutoCancel(matchId: string, minutes: number) {
    await this.postgres.query("SELECT extend_match_auto_cancel($1, $2)", [
      matchId,
      minutes,
    ]);

    this.logger.log(
      `[${matchId}] organizer pushed the deadline back ${minutes} minutes`,
    );

    return { success: true };
  }

  // Cancel, then reopen check-in: what an organizer does by hand with Cancel
  // and Start, in one step. Leaving Canceled clears a map veto; a map that was
  // still being played is put back to the start, or the next server would
  // offer to restore its old rounds.
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

    await this.postgres.transaction(async (client) => {
      if (!canceled) {
        await client.query(
          "UPDATE matches SET status = 'Canceled' WHERE id = $1",
          [matchId],
        );
      }

      const { rows: maps } = await client.query<{ id: string }>(
        `SELECT id FROM match_maps WHERE match_id = $1 AND status = ANY($2)`,
        [matchId, MatchRecoveryService.IN_PROGRESS_MAP_STATUSES],
      );
      for (const map of maps) {
        await client.query("SELECT reset_match_map_to_round($1, 0)", [map.id]);
      }

      if (maps.length > 0) {
        await client.query(
          `UPDATE match_maps SET status = 'Scheduled', started_at = NULL
            WHERE id = ANY($1)`,
          [maps.map((map) => map.id)],
        );
      }

      // Canceled stamped cancels_at with now, and only auto-cancel re-arms it
      // on the way back to check-in. Dropping the server frees its reservation,
      // so the get_match below tells a dedicated server to drop the old game.
      await client.query(
        `UPDATE matches
            SET status = 'WaitingForCheckIn', server_id = NULL, cancels_at = NULL
          WHERE id = $1`,
        [matchId],
      );
    });

    if (match.server_id) {
      await this.matchAssistant.refreshServerMatch(match.server_id);
    }

    this.logger.log(`[${matchId}] organizer restarted the match`);

    return { success: true };
  }

  // Back to warmup on the map being played. Its rounds and stats are only
  // soft-deleted, so a restore can still bring any of them back until a round
  // is played again. The server is told first: if it can't be reached, nothing
  // has been touched.
  public async restartMatchMap(matchId: string, viewer: RecoveryViewer) {
    const match = await this.getMatch(matchId);

    const blockedReason = this.mapControlBlockedReason(
      match,
      viewer,
      await this.isTeamAffiliated(match, viewer.steam_id),
    );
    if (blockedReason === "not_in_progress") {
      throw Error("there is no map in progress to restart");
    }

    if (blockedReason === "team_member") {
      throw Error("organizers on one of the teams can't restart the map");
    }

    const response = await this.matchAssistant.restartServerMap(matchId);
    if (response === undefined) {
      throw Error("the match server can't be reached");
    }

    const refusal = this.serverRefusal(
      response,
      MatchRecoveryService.MATCH_STATE_REFUSED,
    );
    if (refusal) {
      throw Error(refusal);
    }

    await this.postgres.query("SELECT reset_match_map_to_round($1, 0)", [
      match.match_map_id,
    ]);

    this.logger.log(
      `[${matchId}] organizer restarted map ${match.match_map_id} from warmup`,
    );

    return { success: true };
  }

  // The plugin takes a console pause as an admin's technical pause: both teams
  // resume it from chat, or an organizer resumes it at once.
  public async setMatchPaused(matchId: string, paused: boolean) {
    const match = await this.getMatch(matchId);

    const statuses = paused ? ["Live", "Overtime"] : ["Paused"];
    if (match.status !== "Live" || !statuses.includes(match.map_status ?? "")) {
      throw Error(
        paused ? "there is no live map to pause" : "the map isn't paused",
      );
    }

    const response = await this.matchAssistant.setServerPaused(matchId, paused);
    if (response === undefined) {
      throw Error("the match server can't be reached");
    }

    this.logger.log(
      `[${matchId}] organizer ${paused ? "paused" : "resumed"} map ${match.match_map_id}`,
    );

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
          // A player name can end in a backslash, so a quote after one still
          // closes the string when whitespace, a brace or the end follows it.
          if (text[i] === "\\" && text[i + 1] === '"') {
            const after = text[i + 2];
            if (after === undefined || /[\s{}]/.test(after)) {
              value += "\\";
              i++;
              continue;
            }
            value += '"';
            i += 2;
            continue;
          }
          if (text[i] === "\\" && text[i + 1] === "\\") {
            value += "\\";
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

  private restoreBlockedReason(
    match: MatchRow,
    viewer: RecoveryViewer,
    affiliated: boolean,
  ): string | null {
    if (match.type === "Rush") {
      return "rush";
    }

    const blockedReason = this.mapControlBlockedReason(
      match,
      viewer,
      affiliated,
    );
    if (blockedReason) {
      return blockedReason;
    }

    // CS2 restarts the game when warmup or knife ends, which would wipe a
    // round loaded before that. A restarted map's rounds stay restorable
    // until its first round is over.
    if (match.map_status === "Warmup" || match.map_status === "Knife") {
      return "not_live_yet";
    }

    return null;
  }

  private serverRefusal(response: string, prefix: string) {
    const refused = response.indexOf(prefix);
    if (refused === -1) {
      return null;
    }

    return response
      .slice(refused + prefix.length)
      .trim()
      .split("\n")[0];
  }

  private mapControlBlockedReason(
    match: MatchRow,
    viewer: RecoveryViewer,
    affiliated: boolean,
  ): string | null {
    if (
      match.status !== "Live" ||
      !MatchRecoveryService.IN_PROGRESS_MAP_STATUSES.includes(
        match.map_status ?? "",
      )
    ) {
      return "not_in_progress";
    }

    // The in-game reset needs both teams to vote for it; an organizer who is on
    // one of them would skip that vote.
    if (affiliated && !isRoleAbove(viewer.role, "moderator")) {
      return "team_member";
    }

    return null;
  }

  private expectedPlayers(match: MatchRow) {
    return MatchRecoveryService.EXPECTED_PLAYERS[match.type] ?? 10;
  }

  private connectedCount(players: Array<LineupPlayerRow>) {
    return players.filter((player) => player.steam_id && player.is_connected)
      .length;
  }

  private async isTeamAffiliated(match: MatchRow, steamId: string) {
    const [row] = await this.postgres.query<Array<{ affiliated: boolean }>>(
      `SELECT EXISTS (
                SELECT 1 FROM match_lineup_players mlp
                 WHERE mlp.match_lineup_id IN ($1, $2)
                   AND mlp.steam_id = $3
              )
              OR EXISTS (
                SELECT 1 FROM match_lineups ml
                 WHERE ml.id IN ($1, $2)
                   AND ml.coach_steam_id = $3
              )
              OR EXISTS (
                SELECT 1 FROM match_lineups ml
                  JOIN team_roster tr ON tr.team_id = ml.team_id
                 WHERE ml.id IN ($1, $2)
                   AND tr.player_steam_id = $3
                   AND tr.role <> 'Pending'
              ) AS affiliated`,
      [match.lineup_1_id, match.lineup_2_id, steamId],
    );

    return !!row?.affiliated;
  }

  private disconnectedNames(players: Array<LineupPlayerRow>) {
    return players
      .filter((player) => player.steam_id && !player.is_connected)
      .map((player) => player.name || (player.steam_id as string));
  }

  private async getMatch(matchId: string): Promise<MatchRow> {
    const [match] = await this.postgres.query<Array<MatchRow>>(
      `SELECT m.status, m.source, m.server_id::text AS server_id,
              m.winning_lineup_id::text AS winning_lineup_id,
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
              backup_file, deleted_at IS NOT NULL AS undone
         FROM match_map_rounds
        WHERE match_map_id = $1
          AND round > 0
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
