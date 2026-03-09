jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

jest.mock("src/discord-bot/enums/ExpectedPlayers", () => ({
  ExpectedPlayers: { Competitive: 10, Wingman: 4, Duel: 2 },
}));

import MatchUpdatedLineupsEvent from "./MatchUpdatedLineupsEvent";

function createEvent(data: Record<string, any>) {
  const hasura = { mutation: jest.fn().mockResolvedValue({}) };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const matchAssistant = { getMatchLineups: jest.fn() };
  const chat = {};
  const event = new MatchUpdatedLineupsEvent(logger as any, hasura as any, matchAssistant as any, chat as any);
  event.setData("match-1", data as any);
  return { event, hasura, matchAssistant };
}

function makeLineups(lineup1: Array<{ name: string; captain: boolean; steam_id: string }>, lineup2: Array<{ name: string; captain: boolean; steam_id: string }>) {
  return { lineup_1: lineup1, lineup_2: lineup2 };
}

function makePlayer(name: string, steam_id: string, captain = false) {
  return { name, steam_id, captain };
}

describe("MatchUpdatedLineupsEvent", () => {
  it("skips players with steam_id '0'", async () => {
    const { event, hasura, matchAssistant } = createEvent({
      lineups: makeLineups(
        [
          makePlayer("Bot", "0"),
          makePlayer("P1", "s1"),
        ],
        [],
      ),
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_1_id: "l1",
      lineup_2_id: "l2",
      lineup_players: [],
      options: { type: "Competitive" },
    });

    await event.process();

    const calls = hasura.mutation.mock.calls;
    const upsertCalls = calls.filter((c) => c[0].insert_players_one);

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0][0].insert_players_one.__args.object.steam_id).toBe("s1");
  });

  it("upserts each valid player via insert_players_one", async () => {
    const lineup1 = Array.from({ length: 5 }, (_, i) => makePlayer(`P${i}`, `s${i}`));
    const lineup2 = Array.from({ length: 5 }, (_, i) => makePlayer(`P${i + 5}`, `s${i + 5}`));

    const { event, hasura, matchAssistant } = createEvent({
      lineups: makeLineups(lineup1, lineup2),
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_1_id: "l1",
      lineup_2_id: "l2",
      lineup_players: [],
      options: { type: "Competitive" },
    });

    await event.process();

    const upsertCalls = hasura.mutation.mock.calls.filter((c) => c[0].insert_players_one);
    expect(upsertCalls).toHaveLength(10);
  });

  it("returns early without lineup changes when player count < ExpectedPlayers * 2", async () => {
    const lineup1 = [makePlayer("P0", "s0"), makePlayer("P1", "s1")];
    const lineup2 = [makePlayer("P2", "s2"), makePlayer("P3", "s3")];

    const { event, hasura, matchAssistant } = createEvent({
      lineups: makeLineups(lineup1, lineup2),
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_1_id: "l1",
      lineup_2_id: "l2",
      lineup_players: [],
      options: { type: "Competitive" },
    });

    await event.process();

    const deleteCalls = hasura.mutation.mock.calls.filter((c) => c[0].delete_match_lineup_players);
    expect(deleteCalls).toHaveLength(0);

    const insertCalls = hasura.mutation.mock.calls.filter((c) => c[0].insert_match_lineup_players);
    expect(insertCalls).toHaveLength(0);
  });

  it("removes non-participating players from lineups", async () => {
    const lineup1 = Array.from({ length: 10 }, (_, i) => makePlayer(`P${i}`, `s${i}`));
    const lineup2 = Array.from({ length: 10 }, (_, i) => makePlayer(`P${i + 10}`, `s${i + 10}`));

    const { event, hasura, matchAssistant } = createEvent({
      lineups: makeLineups(lineup1, lineup2),
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_1_id: "l1",
      lineup_2_id: "l2",
      lineup_players: [],
      options: { type: "Competitive" },
    });

    await event.process();

    const deleteCalls = hasura.mutation.mock.calls.filter((c) => c[0].delete_match_lineup_players);
    expect(deleteCalls).toHaveLength(1);

    const deleteArgs = deleteCalls[0][0].delete_match_lineup_players.__args;
    expect(deleteArgs.where.match_lineup_id._in).toEqual(["l1", "l2"]);

    const expectedSteamIds = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(deleteArgs.where.steam_id._nin).toEqual(expectedSteamIds);
  });

  it("inserts only new players not already on lineup", async () => {
    const lineup1 = Array.from({ length: 10 }, (_, i) => makePlayer(`P${i}`, `s${i}`));
    const lineup2 = Array.from({ length: 10 }, (_, i) => makePlayer(`P${i + 10}`, `s${i + 10}`));

    const { event, hasura, matchAssistant } = createEvent({
      lineups: makeLineups(lineup1, lineup2),
    });

    matchAssistant.getMatchLineups.mockResolvedValue({
      lineup_1_id: "l1",
      lineup_2_id: "l2",
      lineup_players: [
        { steam_id: "s0" },
        { steam_id: "s1" },
        { steam_id: "s10" },
      ],
      options: { type: "Competitive" },
    });

    await event.process();

    const insertCalls = hasura.mutation.mock.calls.filter((c) => c[0].insert_match_lineup_players);
    expect(insertCalls).toHaveLength(1);

    const insertedObjects = insertCalls[0][0].insert_match_lineup_players.__args.objects;
    expect(insertedObjects).toHaveLength(17);

    const insertedSteamIds = insertedObjects.map((o) => o.steam_id);
    expect(insertedSteamIds).not.toContain("s0");
    expect(insertedSteamIds).not.toContain("s1");
    expect(insertedSteamIds).not.toContain("s10");
    expect(insertedSteamIds).toEqual(expect.arrayContaining([
      "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9",
      "s11", "s12", "s13", "s14", "s15", "s16", "s17", "s18", "s19",
    ]));
  });
});
