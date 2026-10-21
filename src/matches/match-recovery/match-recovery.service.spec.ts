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

const matchRow = (overrides: Partial<MatchFixture> = {}): MatchFixture => ({
  status: "Live",
  server_id: "server-1",
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
  undone: false,
});

const ROUNDS = [
  roundRow(11, 6, 5, ["CT", "TERRORIST"]),
  roundRow(12, 6, 6, ["CT", "TERRORIST"]),
  roundRow(13, 7, 6, ["TERRORIST", "CT"]),
];

const VIEWER = { steam_id: "76561198000000099", role: "user" } as const;

// A full 5v5: vexa and osk carry the backup data, eight more fill the lineups.
const lineupPlayers = (oskConnected: boolean, benchedSub: boolean) => [
  {
    steam_id: VEXA,
    name: "vexa",
    is_connected: true,
    match_lineup_id: LINEUP_1,
  },
  {
    steam_id: OSK,
    name: "osk",
    is_connected: oskConnected,
    match_lineup_id: LINEUP_2,
  },
  ...Array.from({ length: 8 }, (_, index) => ({
    steam_id: steamId(900 + index),
    name: `player${index}`,
    is_connected: true,
    match_lineup_id: index < 4 ? LINEUP_1 : LINEUP_2,
  })),
  ...(benchedSub
    ? [
        {
          steam_id: steamId(999),
          name: "bench",
          is_connected: false,
          match_lineup_id: LINEUP_2,
        },
      ]
    : []),
];

const setup = (
  options: {
    match?: MatchFixture;
    rounds?: Array<ReturnType<typeof roundRow>>;
    oskConnected?: boolean;
    benchedSub?: boolean;
    affiliated?: boolean;
    liveMaps?: Array<{ id: string }>;
    restoreResponse?: string | undefined;
    serverResponse?: string | undefined;
    releasedServer?: string | null;
  } = {},
) => {
  const postgres = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("rewind_map_veto")) {
        return [{ server_id: options.releasedServer ?? null }];
      }
      if (sql.includes("FROM matches m")) {
        return [options.match ?? matchRow()];
      }
      if (sql.includes("FROM match_map_rounds")) {
        return options.rounds ?? ROUNDS;
      }
      if (sql.includes("AS affiliated")) {
        return [{ affiliated: options.affiliated ?? false }];
      }
      if (sql.includes("FROM match_lineup_players")) {
        return lineupPlayers(
          options.oskConnected ?? true,
          options.benchedSub ?? false,
        );
      }
      return [];
    }),
    statements: [] as Array<string>,
    transaction: jest.fn(),
  };
  postgres.transaction.mockImplementation(
    async (fn: (client: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string) => {
          postgres.statements.push(sql.replace(/\s+/g, " ").trim());
          if (sql.includes("SELECT id FROM match_maps")) {
            return { rows: options.liveMaps ?? [] };
          }
          return { rows: [] };
        },
      }),
  );

  const matchAssistant = {
    requestRoundRestore: jest.fn(
      async (): Promise<string | undefined> =>
        "restoreResponse" in options ? options.restoreResponse : "",
    ),
    refreshServerMatch: jest.fn(async (): Promise<void> => undefined),
    restartServerMap: jest.fn(
      async (): Promise<string | undefined> =>
        "serverResponse" in options ? options.serverResponse : "",
    ),
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

    it("keeps a name that ends in a backslash from swallowing the next key", () => {
      const { service } = setup();

      expect(
        service.parseKeyValues(`"name"\t\t"abc\\"\n"cash"\t\t"800"`),
      ).toEqual([
        ["name", "abc\\"],
        ["cash", "800"],
      ]);
    });
  });

  describe("getRestoreRounds", () => {
    it("reads each backup into the players' state for the round after it", async () => {
      const { service } = setup({ oskConnected: false });

      const result = await service.getRestoreRounds("match-1", VIEWER);

      expect(result).toMatchObject({
        match_map_id: MAP_ID,
        restorable: true,
        blocked_reason: null,
        live_round: 14,
        economy_hidden: false,
        connected_players: 9,
        expected_players: 10,
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

      const rounds = (await service.getRestoreRounds("match-1", VIEWER)).rounds;

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

      const rounds = (await service.getRestoreRounds("match-1", VIEWER)).rounds;

      expect(rounds.at(-1)).toMatchObject({
        next_lineup_1_side: "CT",
        next_lineup_2_side: "TERRORIST",
      });
    });

    it("hides every player's economy from an organizer on one of the teams", async () => {
      const { service } = setup({ affiliated: true });

      const result = await service.getRestoreRounds("match-1", VIEWER);

      expect(result).toMatchObject({
        economy_hidden: true,
        blocked_reason: "team_member",
      });
      expect(result.rounds).toHaveLength(3);
      expect(result.rounds.every((round) => round.players.length === 0)).toBe(
        true,
      );
    });

    it("still lets a moderator on one of the teams restore", async () => {
      const { service } = setup({ affiliated: true });

      const result = await service.getRestoreRounds("match-1", {
        steam_id: VIEWER.steam_id,
        role: "moderator",
      });

      expect(result).toMatchObject({
        economy_hidden: true,
        blocked_reason: null,
      });
    });

    it("has nothing to restore in a Rush match", async () => {
      const { service } = setup({ match: matchRow({ type: "Rush" }) });

      expect(await service.getRestoreRounds("match-1", VIEWER)).toMatchObject({
        restorable: false,
        blocked_reason: "rush",
        expected_players: 6,
        rounds: [],
      });
    });

    it("keeps offering the rounds a reset undid and plays on after the last one left", async () => {
      const { service } = setup({
        rounds: [ROUNDS[0], ROUNDS[1], { ...ROUNDS[2], undone: true }],
      });

      const result = await service.getRestoreRounds("match-1", VIEWER);

      expect(result.live_round).toBe(13);
      expect(result.rounds.map((round) => [round.round, round.undone])).toEqual(
        [
          [11, false],
          [12, false],
          [13, true],
        ],
      );
      expect(result.rounds[2].players).toHaveLength(2);
    });

    it("waits for a map back in warmup to go live before offering a restore", async () => {
      const { service } = setup({
        match: matchRow({ map_status: "Warmup" }),
        rounds: ROUNDS.map((row) => ({ ...row, undone: true })),
      });

      const result = await service.getRestoreRounds("match-1", VIEWER);

      expect(result.blocked_reason).toBe("not_live_yet");
      expect(result.rounds).toHaveLength(3);
    });

    it("lists a finished map's rounds without offering a restore", async () => {
      const { service } = setup({
        match: matchRow({ status: "Finished", map_status: "Finished" }),
      });

      expect(await service.getRestoreRounds("match-1", VIEWER)).toMatchObject({
        restorable: false,
        blocked_reason: "not_in_progress",
        live_round: null,
      });
    });
  });

  describe("restoreRound", () => {
    it("asks the server to load the backup", async () => {
      const { service, matchAssistant } = setup();

      await expect(
        service.restoreRound("match-1", 13, VIEWER),
      ).resolves.toEqual({
        success: true,
      });
      expect(matchAssistant.requestRoundRestore).toHaveBeenCalledWith(
        "match-1",
        13,
      );
    });

    // The server refuses a restore while players are missing, after the api
    // has already marked the later rounds' stats for deletion.
    it("brings back a round a reset undid", async () => {
      const { service, matchAssistant } = setup({
        rounds: [ROUNDS[0], { ...ROUNDS[1], undone: true }],
      });

      await service.restoreRound("match-1", 12, VIEWER);

      expect(matchAssistant.requestRoundRestore).toHaveBeenCalledWith(
        "match-1",
        12,
      );
    });

    it("waits for missing players instead of sending it", async () => {
      const { service, matchAssistant } = setup({ oskConnected: false });

      await expect(service.restoreRound("match-1", 13, VIEWER)).rejects.toThrow(
        "waiting for players to reconnect (9/10): osk",
      );
      expect(matchAssistant.requestRoundRestore).not.toHaveBeenCalled();
    });

    it("doesn't wait for a benched substitute", async () => {
      const { service, matchAssistant } = setup({ benchedSub: true });

      await service.restoreRound("match-1", 13, VIEWER);

      expect(matchAssistant.requestRoundRestore).toHaveBeenCalled();
    });

    it("passes on the server's refusal", async () => {
      const { service } = setup({
        restoreResponse:
          "L 10/18/2026 restore_round refused: waiting for all players to reconnect (3/10)\n",
      });

      await expect(service.restoreRound("match-1", 13, VIEWER)).rejects.toThrow(
        /^waiting for all players to reconnect \(3\/10\)$/,
      );
    });

    it("refuses an organizer who is on one of the teams", async () => {
      const { service, matchAssistant } = setup({ affiliated: true });

      await expect(service.restoreRound("match-1", 13, VIEWER)).rejects.toThrow(
        "organizers on one of the teams can't restore rounds",
      );
      expect(matchAssistant.requestRoundRestore).not.toHaveBeenCalled();
    });

    it("refuses a round without a backup", async () => {
      const { service, matchAssistant } = setup({
        rounds: [roundRow(13, 7, 6, ["TERRORIST", "CT"], null)],
      });

      await expect(service.restoreRound("match-1", 13, VIEWER)).rejects.toThrow(
        "round 13 has no backup to restore",
      );
      expect(matchAssistant.requestRoundRestore).not.toHaveBeenCalled();
    });

    it("refuses when no map is being played", async () => {
      const { service } = setup({
        match: matchRow({ map_status: "UploadingDemo" }),
      });

      await expect(service.restoreRound("match-1", 13, VIEWER)).rejects.toThrow(
        "there is no map in progress to restore",
      );
    });

    it.each(["Warmup", "Knife"])(
      "refuses while the map is in %s",
      async (mapStatus) => {
        const { service, matchAssistant } = setup({
          match: matchRow({ map_status: mapStatus }),
        });

        await expect(
          service.restoreRound("match-1", 13, VIEWER),
        ).rejects.toThrow("the map isn't live yet; restore once it is");
        expect(matchAssistant.requestRoundRestore).not.toHaveBeenCalled();
      },
    );

    it("refuses Rush matches", async () => {
      const { service } = setup({ match: matchRow({ type: "Rush" }) });

      await expect(service.restoreRound("match-1", 13, VIEWER)).rejects.toThrow(
        "Rush matches can't restore rounds",
      );
    });

    it("says so when the server can't be reached", async () => {
      const { service } = setup({ restoreResponse: undefined });

      await expect(service.restoreRound("match-1", 13, VIEWER)).rejects.toThrow(
        "the match server can't be reached",
      );
    });
  });

  describe("restartMatch", () => {
    it("cancels a live match, puts the map in progress back to the start, then reopens check-in", async () => {
      const { service, postgres, matchAssistant } = setup({
        liveMaps: [{ id: MAP_ID }],
      });

      await service.restartMatch("match-1");

      expect(postgres.statements).toEqual([
        "UPDATE matches SET status = 'Canceled' WHERE id = $1",
        "SELECT id FROM match_maps WHERE match_id = $1 AND status = ANY($2)",
        "SELECT reset_match_map_to_round($1, 0)",
        "UPDATE match_maps SET status = 'Scheduled', started_at = NULL WHERE id = ANY($1)",
        "UPDATE matches SET status = 'WaitingForCheckIn', server_id = NULL, cancels_at = NULL WHERE id = $1",
      ]);
      expect(matchAssistant.refreshServerMatch).toHaveBeenCalledWith(
        "server-1",
      );
    });

    it("reopens a canceled match without touching maps nobody is playing", async () => {
      const { service, postgres, matchAssistant } = setup({
        match: matchRow({ status: "Canceled", server_id: null }),
      });

      await service.restartMatch("match-1");

      expect(postgres.statements).toEqual([
        "SELECT id FROM match_maps WHERE match_id = $1 AND status = ANY($2)",
        "UPDATE matches SET status = 'WaitingForCheckIn', server_id = NULL, cancels_at = NULL WHERE id = $1",
      ]);
      expect(matchAssistant.refreshServerMatch).not.toHaveBeenCalled();
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
      const { service, postgres } = setup({ match });

      await expect(service.restartMatch("match-1")).rejects.toThrow(message);
      expect(postgres.transaction).not.toHaveBeenCalled();
    });
  });

  describe("rewindMapVeto", () => {
    it("tells the released server to drop the old maps", async () => {
      const { service, postgres, matchAssistant } = setup({
        releasedServer: "server-1",
      });

      await service.rewindMapVeto("match-1", 5, 9);

      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("rewind_map_veto($1, $2, $3)"),
        ["match-1", 5, 9],
      );
      expect(matchAssistant.refreshServerMatch).toHaveBeenCalledWith(
        "server-1",
      );
    });

    it("leaves servers alone while the veto is still running", async () => {
      const { service, postgres, matchAssistant } = setup();

      await service.rewindMapVeto("match-1", 2);

      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("rewind_map_veto($1, $2, $3)"),
        ["match-1", 2, null],
      );
      expect(matchAssistant.refreshServerMatch).not.toHaveBeenCalled();
    });
  });

  describe("restartMatchMap", () => {
    const resets = (postgres: ReturnType<typeof setup>["postgres"]) =>
      postgres.query.mock.calls.filter(([sql]) =>
        sql.includes("reset_match_map_to_round"),
      );

    it("sends the server back to warmup, then puts the map's rounds back to the start", async () => {
      const { service, postgres, matchAssistant } = setup();

      await expect(service.restartMatchMap("match-1", VIEWER)).resolves.toEqual(
        { success: true },
      );

      expect(matchAssistant.restartServerMap).toHaveBeenCalledWith("match-1");
      expect(resets(postgres)).toEqual([
        ["SELECT reset_match_map_to_round($1, 0)", [MAP_ID]],
      ]);
      const resetCall = postgres.query.mock.calls.findIndex(([sql]) =>
        sql.includes("reset_match_map_to_round"),
      );
      expect(
        matchAssistant.restartServerMap.mock.invocationCallOrder[0],
      ).toBeLessThan(postgres.query.mock.invocationCallOrder[resetCall]);
    });

    it("leaves the rounds alone when the server can't be reached", async () => {
      const { service, postgres } = setup({ serverResponse: undefined });

      await expect(service.restartMatchMap("match-1", VIEWER)).rejects.toThrow(
        "the match server can't be reached",
      );
      expect(resets(postgres)).toEqual([]);
    });

    it("passes on the server's refusal and leaves the rounds alone", async () => {
      const { service, postgres } = setup({
        serverResponse: "match_state refused: the map is already over\n",
      });

      await expect(service.restartMatchMap("match-1", VIEWER)).rejects.toThrow(
        /^the map is already over$/,
      );
      expect(resets(postgres)).toEqual([]);
    });

    it("restarts a map still in warmup", async () => {
      const { service, postgres } = setup({
        match: matchRow({ map_status: "Warmup" }),
      });

      await service.restartMatchMap("match-1", VIEWER);

      expect(resets(postgres)).toHaveLength(1);
    });

    it("restarts a Rush map, which replays from warmup anyway", async () => {
      const { service, postgres } = setup({
        match: matchRow({ type: "Rush" }),
      });

      await service.restartMatchMap("match-1", VIEWER);

      expect(resets(postgres)).toHaveLength(1);
    });

    it.each([
      [
        { match: matchRow({ map_status: "UploadingDemo" }) },
        "there is no map in progress to restart",
      ],
      [
        { match: matchRow({ status: "Finished" }) },
        "there is no map in progress to restart",
      ],
      [
        { affiliated: true },
        "organizers on one of the teams can't restart the map",
      ],
    ])("refuses %#", async (options, message) => {
      const { service, postgres, matchAssistant } = setup(options);

      await expect(service.restartMatchMap("match-1", VIEWER)).rejects.toThrow(
        message,
      );
      expect(matchAssistant.restartServerMap).not.toHaveBeenCalled();
      expect(resets(postgres)).toEqual([]);
    });
  });
});
