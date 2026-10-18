import { MatchRecoveryService } from "./match-recovery.service";

const LINEUP_1 = "11111111-1111-1111-1111-111111111111";
const LINEUP_2 = "22222222-2222-2222-2222-222222222222";
const MAP_ID = "33333333-3333-3333-3333-333333333333";

const steamId = (accountId: number) =>
  (BigInt(accountId) + 76561197960265728n).toString();

const VEXA = steamId(157864);
const OSK = steamId(235177);

// Trimmed from a real CS2 round backup; names and ids are made up.
const BACKUP = `"SaveFile"
{
	"timestamp"		"2026-10-04 04:44:23"
	"team1"		"Kestrel"
	"team2"		"Riptide"
	"map"		"de_mirage"
	"round"		"13"
	"FirstHalfScore"
	{
		"team1"		"6"
		"team2"		"6"
	}
	"PlayersOnTeam1"
	{
		"157864"
		{
			"name"		"vexa"
			"kills"		"12"
			"assists"		"3"
			"deaths"		"8"
			"cash"		"5600"
			"helmet"		"1"
			"armor"		"94"
			"Items"
			{
				"item"		"weapon_knife_butterfly"
				"item"		"weapon_glock"
				"item"		"weapon_ak47"
			}
			"MatchStats"
			{
				"Damage"
				{
					"round1"		"27"
				}
			}
		}
	}
	"PlayersOnTeam2"
	{
		"235177"
		{
			"name"		"osk"
			"kills"		"10"
			"assists"		"1"
			"deaths"		"9"
			"cash"		"1900"
			"helmet"		"0"
		}
	}
}
`;

type MatchFixture = {
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

const matchRow = (overrides: Partial<MatchFixture> = {}): MatchFixture => ({
  status: "Live",
  source: "5stack",
  winning_lineup_id: null,
  lineup_1_id: LINEUP_1,
  lineup_2_id: LINEUP_2,
  type: "Competitive",
  mr: 12,
  match_map_id: MAP_ID,
  map_status: "Live",
  map_name: "de_mirage",
  start_lineup_1_side: "CT",
  start_lineup_2_side: "TERRORIST",
  ...overrides,
});

const roundRow = (
  round: number,
  lineup1Score: number,
  lineup2Score: number,
  sides: [string, string],
  backup: string | null = BACKUP,
) => ({
  round,
  lineup_1_score: lineup1Score,
  lineup_2_score: lineup2Score,
  lineup_1_side: sides[0],
  lineup_2_side: sides[1],
  winning_side: "CT",
  winning_reason: "CTsWin",
  lineup_1_timeouts_available: 2,
  lineup_2_timeouts_available: 3,
  backup_file: backup,
});

const ROUNDS = [
  roundRow(11, 6, 5, ["CT", "TERRORIST"]),
  roundRow(12, 6, 6, ["CT", "TERRORIST"]),
  roundRow(13, 7, 6, ["TERRORIST", "CT"]),
];

const setup = (
  options: {
    match?: MatchFixture;
    rounds?: Array<ReturnType<typeof roundRow>>;
    oskConnected?: boolean;
    restoreResponse?: string | undefined;
  } = {},
) => {
  const postgres = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("FROM matches m")) {
        return [options.match ?? matchRow()];
      }
      if (sql.includes("FROM match_map_rounds")) {
        return options.rounds ?? ROUNDS;
      }
      if (sql.includes("FROM match_lineup_players")) {
        return [
          {
            steam_id: VEXA,
            name: "vexa",
            is_connected: true,
            match_lineup_id: LINEUP_1,
          },
          {
            steam_id: OSK,
            name: "osk",
            is_connected: options.oskConnected ?? true,
            match_lineup_id: LINEUP_2,
          },
        ];
      }
      return [];
    }),
  };

  const matchAssistant = {
    requestRoundRestore: jest.fn(
      async (): Promise<string | undefined> =>
        "restoreResponse" in options ? options.restoreResponse : "",
    ),
    updateMatchStatus: jest.fn(async (): Promise<void> => undefined),
  };

  const service = new MatchRecoveryService(
    { log: jest.fn(), warn: jest.fn() } as never,
    postgres as never,
    matchAssistant as never,
  );

  return { service, postgres, matchAssistant };
};

describe("MatchRecoveryService", () => {
  describe("parseKeyValues", () => {
    it("keeps nesting and repeated keys", () => {
      const { service } = setup();

      const [[root, save]] = service.parseKeyValues(BACKUP);
      expect(root).toBe("SaveFile");

      const team = (save as Array<[string, unknown]>).find(
        ([key]) => key === "PlayersOnTeam1",
      )![1] as Array<[string, Array<[string, unknown]>]>;
      const items = team[0][1].find(([key]) => key === "Items")![1];

      expect(items).toEqual([
        ["item", "weapon_knife_butterfly"],
        ["item", "weapon_glock"],
        ["item", "weapon_ak47"],
      ]);
    });

    it("reads escaped quotes and skips comments", () => {
      const { service } = setup();

      expect(
        service.parseKeyValues(
          `// header\n"a" "say \\"hi\\""\n"b" { "c" "d" }`,
        ),
      ).toEqual([
        ["a", 'say "hi"'],
        ["b", [["c", "d"]]],
      ]);
    });
  });

  describe("getRestoreRounds", () => {
    it("reads each backup into the players' state for the round after it", async () => {
      const { service } = setup({ oskConnected: false });

      const result = await service.getRestoreRounds("match-1", "someone-else");

      expect(result).toMatchObject({
        match_map_id: MAP_ID,
        restorable: true,
        blocked_reason: null,
        live_round: 14,
        economy_hidden: false,
        disconnected: ["osk"],
      });

      const last = result.rounds.at(-1)!;
      expect(last).toMatchObject({
        round: 13,
        lineup_1_score: 7,
        lineup_2_score: 6,
        lineup_1_timeouts: 2,
        has_backup: true,
      });
      expect(last.players).toEqual([
        {
          steam_id: VEXA,
          name: "vexa",
          lineup: 1,
          cash: 5600,
          armor: 94,
          helmet: true,
          alive: true,
          weapons: ["weapon_glock", "weapon_ak47"],
          kills: 12,
          deaths: 8,
          assists: 3,
        },
        {
          steam_id: OSK,
          name: "osk",
          lineup: 2,
          cash: 1900,
          armor: 0,
          helmet: false,
          alive: false,
          weapons: [],
          kills: 10,
          deaths: 9,
          assists: 1,
        },
      ]);
    });

    it("gives each round the sides the next round is played on", async () => {
      const { service } = setup();

      const rounds = (await service.getRestoreRounds("match-1")).rounds;

      expect(
        rounds.map((round) => [
          round.round,
          round.next_lineup_1_side,
          round.next_lineup_2_side,
        ]),
      ).toEqual([
        [11, "CT", "TERRORIST"],
        [12, "TERRORIST", "CT"],
        [13, "TERRORIST", "CT"],
      ]);
    });

    it("switches sides each overtime half", async () => {
      const { service } = setup({
        rounds: [
          roundRow(24, 12, 12, ["TERRORIST", "CT"]),
          roundRow(27, 14, 13, ["TERRORIST", "CT"]),
        ],
      });

      const rounds = (await service.getRestoreRounds("match-1")).rounds;

      expect(rounds.at(-1)).toMatchObject({
        next_lineup_1_side: "CT",
        next_lineup_2_side: "TERRORIST",
      });
    });

    it("hides every player's economy from someone playing in the match", async () => {
      const { service } = setup();

      const result = await service.getRestoreRounds("match-1", VEXA);

      expect(result.economy_hidden).toBe(true);
      expect(result.rounds).toHaveLength(3);
      expect(result.rounds.every((round) => round.players.length === 0)).toBe(
        true,
      );
    });

    it("has nothing to restore in a Rush match", async () => {
      const { service } = setup({ match: matchRow({ type: "Rush" }) });

      expect(await service.getRestoreRounds("match-1")).toMatchObject({
        restorable: false,
        blocked_reason: "rush",
        rounds: [],
      });
    });

    it("lists a finished map's rounds without offering a restore", async () => {
      const { service } = setup({
        match: matchRow({ status: "Finished", map_status: "Finished" }),
      });

      expect(await service.getRestoreRounds("match-1")).toMatchObject({
        restorable: false,
        blocked_reason: "not_in_progress",
        live_round: null,
      });
    });
  });

  describe("restoreRound", () => {
    it("asks the server to load the backup", async () => {
      const { service, matchAssistant } = setup();

      await expect(service.restoreRound("match-1", 13)).resolves.toEqual({
        success: true,
      });
      expect(matchAssistant.requestRoundRestore).toHaveBeenCalledWith(
        "match-1",
        13,
      );
    });

    // The server refuses a restore while anyone is missing, after the api has
    // already marked the later rounds' stats for deletion.
    it("waits for disconnected players instead of sending it", async () => {
      const { service, matchAssistant } = setup({ oskConnected: false });

      await expect(service.restoreRound("match-1", 13)).rejects.toThrow(
        "waiting for osk to reconnect",
      );
      expect(matchAssistant.requestRoundRestore).not.toHaveBeenCalled();
    });

    it("refuses a round without a backup", async () => {
      const { service, matchAssistant } = setup({
        rounds: [roundRow(13, 7, 6, ["TERRORIST", "CT"], null)],
      });

      await expect(service.restoreRound("match-1", 13)).rejects.toThrow(
        "round 13 has no backup to restore",
      );
      expect(matchAssistant.requestRoundRestore).not.toHaveBeenCalled();
    });

    it("refuses when no map is being played", async () => {
      const { service } = setup({
        match: matchRow({ map_status: "UploadingDemo" }),
      });

      await expect(service.restoreRound("match-1", 13)).rejects.toThrow(
        "there is no map in progress to restore",
      );
    });

    it("refuses Rush matches", async () => {
      const { service } = setup({ match: matchRow({ type: "Rush" }) });

      await expect(service.restoreRound("match-1", 13)).rejects.toThrow(
        "Rush matches can't restore rounds",
      );
    });

    it("says so when the server can't be reached", async () => {
      const { service } = setup({ restoreResponse: undefined });

      await expect(service.restoreRound("match-1", 13)).rejects.toThrow(
        "the match server can't be reached",
      );
    });
  });

  describe("restartMatch", () => {
    it("cancels a live match, then reopens check-in", async () => {
      const { service, matchAssistant } = setup();

      await service.restartMatch("match-1");

      expect(matchAssistant.updateMatchStatus.mock.calls).toEqual([
        ["match-1", "Canceled"],
        ["match-1", "WaitingForCheckIn"],
      ]);
    });

    it("reopens a canceled match straight away", async () => {
      const { service, matchAssistant } = setup({
        match: matchRow({ status: "Canceled" }),
      });

      await service.restartMatch("match-1");

      expect(matchAssistant.updateMatchStatus.mock.calls).toEqual([
        ["match-1", "WaitingForCheckIn"],
      ]);
    });

    it.each([
      [matchRow({ status: "Finished" }), "a Finished match can't be restarted"],
      [
        matchRow({ status: "Canceled", winning_lineup_id: LINEUP_1 }),
        "this match already has a result",
      ],
      [
        matchRow({ source: "faceit" }),
        "only matches played on 5stack servers can be restarted",
      ],
    ])("refuses %#", async (match, message) => {
      const { service, matchAssistant } = setup({ match });

      await expect(service.restartMatch("match-1")).rejects.toThrow(message);
      expect(matchAssistant.updateMatchStatus).not.toHaveBeenCalled();
    });
  });
});
