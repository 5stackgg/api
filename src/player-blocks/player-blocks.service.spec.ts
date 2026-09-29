import { PlayerBlocksService } from "./player-blocks.service";

describe("PlayerBlocksService", () => {
  let postgres: { query: jest.Mock };
  let service: PlayerBlocksService;

  beforeEach(() => {
    postgres = { query: jest.fn() };
    service = new PlayerBlocksService(postgres as never);
  });

  describe("isBlockedEitherWay", () => {
    it("asks the shared SQL function about the pair", async () => {
      postgres.query.mockResolvedValue([{ blocked: true }]);

      await expect(service.isBlockedEitherWay("1", "2")).resolves.toBe(true);
      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining(
          "public.is_blocked_either_way($1::bigint, $2::bigint)",
        ),
        ["1", "2"],
      );
    });

    it("treats anything but a true answer as not blocked", async () => {
      postgres.query.mockResolvedValue([{ blocked: false }]);
      await expect(service.isBlockedEitherWay("1", "2")).resolves.toBe(false);

      postgres.query.mockResolvedValue([]);
      await expect(service.isBlockedEitherWay("1", "2")).resolves.toBe(false);
    });
  });

  describe("hasBlocked", () => {
    it("is directional: blocker first, blocked second", async () => {
      postgres.query.mockResolvedValue([{ blocked: true }]);

      await expect(service.hasBlocked("1", "2")).resolves.toBe(true);
      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining(
          "public.has_blocked_player($1::bigint, $2::bigint)",
        ),
        ["1", "2"],
      );
    });
  });

  describe("blockedBy", () => {
    it("returns only the players the viewer blocked", async () => {
      postgres.query.mockResolvedValue([
        { steam_id: "10" },
        { steam_id: "11" },
      ]);

      await expect(service.blockedBy("1")).resolves.toEqual(
        new Set(["10", "11"]),
      );

      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).toContain("WHERE pb.blocker_steam_id = $1::bigint");
      expect(sql).not.toContain("blocked_steam_id = $1");
      expect(params).toEqual(["1", []]);
    });

    it("hands the exempt roles to the same query", async () => {
      postgres.query.mockResolvedValue([]);

      await service.blockedBy("1", ["moderator", "administrator"]);

      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).toContain("p.role::text <> ALL($2::text[])");
      expect(params).toEqual(["1", ["moderator", "administrator"]]);
    });
  });

  describe("blockedAmong", () => {
    it("never queries without viewers or authors", async () => {
      await expect(service.blockedAmong([], ["2"])).resolves.toEqual(new Map());
      await expect(service.blockedAmong(["1"], [])).resolves.toEqual(new Map());
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("maps each viewer to the authors that viewer blocked, in one query", async () => {
      postgres.query.mockResolvedValue([
        { viewer: "1", author: "10" },
        { viewer: "1", author: "11" },
        { viewer: "2", author: "10" },
      ]);

      await expect(
        service.blockedAmong(["1", "2", "3"], ["10", "11"]),
      ).resolves.toEqual(
        new Map([
          ["1", new Set(["10", "11"])],
          ["2", new Set(["10"])],
        ]),
      );

      expect(postgres.query).toHaveBeenCalledTimes(1);
      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).toContain("blocker_steam_id = ANY($1::bigint[])");
      expect(sql).toContain("blocked_steam_id = ANY($2::bigint[])");
      expect(params).toEqual([["1", "2", "3"], ["10", "11"], []]);
    });

    it("leaves out viewers whose role is exempt, in the same query", async () => {
      postgres.query.mockResolvedValue([]);

      await service.blockedAmong(["1"], ["10"], ["moderator"]);

      expect(postgres.query).toHaveBeenCalledTimes(1);
      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).toContain("p.role::text <> ALL($3::text[])");
      expect(params).toEqual([["1"], ["10"], ["moderator"]]);
    });
  });

  describe("filterUnblocked", () => {
    it("never queries for an empty candidate list", async () => {
      await expect(service.filterUnblocked("1", [])).resolves.toEqual([]);
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("keeps the candidates the database did not drop, in the order given", async () => {
      postgres.query.mockResolvedValue([{ steam_id: "3" }, { steam_id: "5" }]);

      await expect(
        service.filterUnblocked("1", ["3", "4", "5"]),
      ).resolves.toEqual(["3", "5"]);

      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).toContain("NOT public.is_blocked_either_way($1::bigint");
      expect(sql).toContain("ORDER BY candidate.position");
      expect(params).toEqual(["1", ["3", "4", "5"]]);
    });
  });
});
