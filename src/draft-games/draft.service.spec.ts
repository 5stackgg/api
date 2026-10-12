import { Logger } from "@nestjs/common";
import { DraftService } from "./draft.service";
import { DraftGameService } from "./draft-game.service";
import { DraftGame, DraftGamePlayer } from "./types/DraftGame";

describe("DraftService picking for a captain whose clock ran out", () => {
  let hasura: { mutation: jest.Mock };

  const player = (
    steamId: string,
    overrides: Partial<DraftGamePlayer> = {},
  ): DraftGamePlayer => ({
    steam_id: steamId,
    name: steamId,
    status: "Accepted",
    is_captain: false,
    lineup: undefined,
    elo_snapshot: 1500,
    joined_at: "2026-10-11T18:00:00Z",
    ...overrides,
  });

  const captains = [
    player("captain-1", { is_captain: true, lineup: 1, pick_order: 0 }),
    player("captain-2", { is_captain: true, lineup: 2, pick_order: 0 }),
  ];

  const build = (players: Array<DraftGamePlayer>) => {
    hasura = { mutation: jest.fn(async () => ({})) };
    const draftGame = {
      id: "draft-1",
      status: "Drafting",
      match_id: undefined,
      current_pick_lineup: 1,
      players: [...captains, ...players],
    } as unknown as DraftGame;

    return new DraftService(
      new Logger("DraftServiceTest"),
      hasura as never,
      {
        lock: jest.fn(async (_key: string, callback: () => unknown) =>
          callback(),
        ),
      } as never,
      { getConnection: () => ({}) } as never,
      {
        getDraftGame: jest.fn(async () => draftGame),
        acceptedPlayers: DraftGameService.prototype.acceptedPlayers,
      } as never,
      {} as never,
      {} as never,
    );
  };

  const pickedSteamId = () =>
    hasura.mutation.mock.calls[0][0].insert_draft_game_picks_one.__args.object
      .picked_steam_id;

  it("picks the best player in the pool, never a backup or a pending invite", async () => {
    const service = build([
      player("pool-low", { elo_snapshot: 1600 }),
      player("pool-best", { elo_snapshot: 1700 }),
      player("backup", { status: "Waitlist", elo_snapshot: 2500 }),
      player("invited", { status: "Invited", elo_snapshot: 2400 }),
      player("requested", { status: "Requested", elo_snapshot: 2300 }),
    ]);

    await service.autoPick("draft-1", 0);

    expect(pickedSteamId()).toBe("pool-best");
  });

  it("gives a rating tie to whoever joined the lobby first", async () => {
    const service = build([
      player("joined-later", {
        elo_snapshot: 5000,
        joined_at: "2026-10-11T18:05:00Z",
      }),
      player("joined-first", {
        elo_snapshot: 5000,
        joined_at: "2026-10-11T18:01:00Z",
      }),
    ]);

    await service.autoPick("draft-1", 0);

    expect(pickedSteamId()).toBe("joined-first");
  });
});
