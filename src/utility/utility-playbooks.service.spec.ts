import { UtilityPlaybooksService } from "./utility-playbooks.service";

const PLAYER = "76561198000000001";

describe("UtilityPlaybooksService.forPlayer", () => {
  it("sends the player's and their team's executes for one map, steps and all", async () => {
    const postgres = {
      query: jest.fn(async (sql: string, _bindings: unknown[]) => {
        if (sql.includes("FROM public.utility_playbooks p")) {
          return [
            { id: "one", name: "A execute", map_name: "de_mirage", side: "T" },
            { id: "two", name: "B split", map_name: "de_mirage", side: "T" },
          ];
        }

        return [
          {
            step_order: 0,
            offset_ms: 1500,
            utility_lineup_id: "lineup",
            assigned_steam_id: null as string | null,
            note: null as string | null,
            id: "lineup",
            name: "Jungle",
          },
        ];
      }),
    };
    const service = new UtilityPlaybooksService(postgres as any);

    const books = await service.forPlayer("de_mirage", PLAYER);

    expect(books.map((book) => book.id)).toEqual(["one", "two"]);
    expect(books[0].steps).toEqual([
      {
        step_order: 0,
        offset_ms: 1500,
        utility_lineup_id: "lineup",
        assigned_steam_id: null,
        note: null,
        lineup: { id: "lineup", name: "Jungle" },
      },
    ]);

    const [sql, parameters] = postgres.query.mock.calls[0];

    expect(sql).toContain("p.owner_steam_id = $2::bigint");
    expect(sql).toContain("is_utility_team_member(p.team_id, $2::bigint)");
    expect(sql).not.toContain("'Public'");
    expect(parameters).toEqual([
      "de_mirage",
      PLAYER,
      UtilityPlaybooksService.MAX_FOR_PLAYER,
    ]);
  });
});
