import { Logger } from "@nestjs/common";
import { DraftMatchService } from "./draft-match.service";
import { DraftGame, DraftGamePlayer } from "./types/DraftGame";

describe("DraftMatchService swapping a no-show at check-in", () => {
  let hasura: { query: jest.Mock; mutation: jest.Mock };

  const host = { steam_id: "host", role: "user" } as never;

  const player = (
    steamId: string,
    overrides: Partial<DraftGamePlayer> = {},
  ): DraftGamePlayer => ({
    steam_id: steamId,
    name: steamId,
    status: "Accepted",
    is_captain: false,
    lineup: 1,
    joined_at: "2026-10-16T18:00:00Z",
    ...overrides,
  });

  const lineupPlayer = (
    steamId: string,
    overrides: { checked_in?: boolean; captain?: boolean } = {},
  ) => ({ steam_id: steamId, checked_in: false, captain: false, ...overrides });

  const build = ({
    status = "WaitingForCheckIn",
    lineup1 = [
      lineupPlayer("no-show", { captain: true }),
      lineupPlayer("named", { checked_in: true }),
      lineupPlayer("first-placed", { checked_in: true }),
    ],
    players = [
      player("no-show", { pick_order: 1 }),
      player("first-placed", { pick_order: 2 }),
      player("named", { pick_order: 3, is_captain: true }),
      player("backup", { status: "Waitlist", lineup: undefined }),
    ],
  }: {
    status?: string;
    lineup1?: Array<ReturnType<typeof lineupPlayer>>;
    players?: Array<DraftGamePlayer>;
  } = {}) => {
    const draftGame = {
      id: "draft-1",
      host_steam_id: "host",
      status: "Completed",
      match_id: "match-1",
      players,
    } as unknown as DraftGame;

    const afterSwap = {
      ...draftGame,
      players: players
        .filter((entry) => entry.steam_id !== "no-show")
        .map((entry) =>
          entry.steam_id === "backup"
            ? { ...entry, status: "Accepted", lineup: 1 }
            : entry,
        ),
    } as DraftGame;

    hasura = {
      query: jest.fn(async () => ({
        matches_by_pk: {
          status,
          lineup_1_id: "lineup-1",
          lineup_2_id: "lineup-2",
          lineup_1: { lineup_players: lineup1 },
          lineup_2: { lineup_players: [] as typeof lineup1 },
        },
      })),
      mutation: jest.fn(async () => ({})),
    };

    const getDraftGame = jest
      .fn()
      .mockResolvedValueOnce(draftGame)
      .mockResolvedValue(afterSwap);

    return new DraftMatchService(
      new Logger("DraftMatchServiceTest"),
      hasura as never,
      {
        lock: jest.fn(async (_key: string, callback: () => unknown) =>
          callback(),
        ),
      } as never,
      {} as never,
      {} as never,
      {
        getDraftGame,
        isOrganizerOrHost: (user: { steam_id: string }, game: DraftGame) =>
          user.steam_id === game.host_steam_id,
      } as never,
    );
  };

  const mutations = () =>
    hasura.mutation.mock.calls.map(([mutation]) => Object.keys(mutation)[0]);

  const mutationOf = (name: string) =>
    hasura.mutation.mock.calls.find(([mutation]) => mutation[name])?.[0][name];

  it("seats the backup in the no-show's place and hands the armband to the captain the host named", async () => {
    const service = build();

    await service.replaceNoShow(host, "draft-1", "no-show", "backup");

    expect(mutations()).toEqual([
      "delete_match_lineup_players",
      "insert_match_lineup_players",
      "delete_draft_game_players_by_pk",
      "update_draft_game_players_by_pk",
      "update_match_lineup_players",
    ]);
    expect(mutationOf("insert_match_lineup_players").__args.objects).toEqual([
      { steam_id: "backup", match_lineup_id: "lineup-1" },
    ]);
    expect(mutationOf("update_draft_game_players_by_pk").__args._set).toEqual({
      status: "Accepted",
      lineup: 1,
    });
    expect(
      mutationOf("update_match_lineup_players").__args.where.steam_id,
    ).toEqual({ _eq: "named" });
  });

  it("drops a no-show without a replacement", async () => {
    const service = build({
      lineup1: [lineupPlayer("no-show"), lineupPlayer("named")],
    });

    await service.replaceNoShow(host, "draft-1", "no-show");

    expect(mutations()).toEqual([
      "delete_match_lineup_players",
      "delete_draft_game_players_by_pk",
    ]);
  });

  it("refuses to pull someone who already checked in", async () => {
    const service = build({
      lineup1: [lineupPlayer("no-show", { checked_in: true })],
    });

    await expect(
      service.replaceNoShow(host, "draft-1", "no-show", "backup"),
    ).rejects.toThrow("already checked in");
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("only swaps during check-in", async () => {
    const service = build({ status: "Veto" });

    await expect(
      service.replaceNoShow(host, "draft-1", "no-show", "backup"),
    ).rejects.toThrow("during check-in");
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("only swaps in a backup", async () => {
    const service = build();

    await expect(
      service.replaceNoShow(host, "draft-1", "no-show", "first-placed"),
    ).rejects.toThrow("backups");
  });

  it("is for the host only", async () => {
    const service = build();

    await expect(
      service.replaceNoShow(
        { steam_id: "named", role: "user" } as never,
        "draft-1",
        "no-show",
        "backup",
      ),
    ).rejects.toThrow("host");
  });
});
