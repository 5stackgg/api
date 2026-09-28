import { SanctionsService } from "./sanctions.service";

describe("SanctionsService", () => {
  let service: SanctionsService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let rcon: { send: jest.Mock };
  let rconService: { connect: jest.Mock; disconnect: jest.Mock };
  let dedicatedServers: {
    getServerPlayerList: jest.Mock;
    resolveServerUserId: jest.Mock;
  };

  const steamId = "76561198000000001";
  const moderator = "76561198000000009";

  const insertedSanction = () =>
    hasura.mutation.mock.calls
      .map(([mutation]) => mutation.insert_player_sanctions_one)
      .find(Boolean)?.__args.object;

  beforeEach(() => {
    hasura = {
      query: jest.fn().mockResolvedValue({ matches: [{ id: "match-1" }] }),
      mutation: jest.fn(async (mutation: any) =>
        mutation.insert_player_sanctions_one
          ? { insert_player_sanctions_one: { id: "sanction-1" } }
          : {},
      ),
    };
    postgres = { query: jest.fn().mockResolvedValue([]) };
    rcon = { send: jest.fn().mockResolvedValue("") };
    rconService = {
      connect: jest.fn().mockResolvedValue(rcon),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    dedicatedServers = {
      getServerPlayerList: jest
        .fn()
        .mockResolvedValue([{ steam_id: steamId, name: "keith", userid: "4" }]),
      resolveServerUserId: jest.fn(),
    };

    service = new SanctionsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      hasura as any,
      postgres as any,
      rconService as any,
      dedicatedServers as any,
    );
  });

  describe("warnings", () => {
    it.each([undefined, null, "", "   "])(
      "refuses a warning without a reason (%p)",
      async (reason) => {
        await expect(
          service.sanctionServerPlayer({
            steamId,
            type: "warning",
            reason,
            sanctionedBySteamId: moderator,
          }),
        ).rejects.toThrow("a reason is required for a warning");

        expect(insertedSanction()).toBeUndefined();
      },
    );

    it("saves the trimmed reason and never sets an end date", async () => {
      const result = await service.sanctionServerPlayer({
        steamId,
        type: "warning",
        reason: "  toxic in voice  ",
        duration: 60_000,
        sanctionedBySteamId: moderator,
      });

      expect(insertedSanction()).toEqual({
        type: "warning",
        player_steam_id: steamId,
        sanctioned_by_steam_id: moderator,
        reason: "toxic in voice",
        remove_sanction_date: null,
      });
      expect(result).toEqual({
        id: "sanction-1",
        enforced: false,
        message: "warning saved",
      });
    });

    it("never touches the server, even when one is named", async () => {
      await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "warning",
        reason: "toxic in voice",
        sanctionedBySteamId: moderator,
      });

      expect(dedicatedServers.getServerPlayerList).not.toHaveBeenCalled();
      expect(rconService.connect).not.toHaveBeenCalled();
      expect(rcon.send).not.toHaveBeenCalled();
    });

    it("still syncs the server for an enforced sanction", async () => {
      await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "ban",
        reason: "cheating",
        sanctionedBySteamId: moderator,
      });

      expect(rconService.connect).toHaveBeenCalledWith("server-1");
      expect(rcon.send).toHaveBeenCalledWith("kickid 4 Banned");
      expect(rcon.send).toHaveBeenCalledWith("get_match");
    });
  });

  describe("getActiveServerSanctions", () => {
    it("only reads the types a server enforces", async () => {
      await service.getActiveServerSanctions("server-1");

      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).toContain("type = ANY($1::text[])");
      expect(params).toEqual([["ban", "mute", "gag", "silence"]]);
      expect(params[0]).not.toContain("warning");
    });

    it("maps the enforced types onto the plugin flags", async () => {
      postgres.query.mockResolvedValueOnce([
        { player_steam_id: "1", type: "ban" },
        { player_steam_id: "2", type: "silence" },
        { player_steam_id: "3", type: "mute" },
      ]);

      expect(await service.getActiveServerSanctions("server-1")).toEqual([
        { steam_id: "1", is_banned: true, is_muted: false, is_gagged: false },
        { steam_id: "2", is_banned: false, is_muted: true, is_gagged: true },
        { steam_id: "3", is_banned: false, is_muted: true, is_gagged: false },
      ]);
    });
  });

  describe("unsanctionServerPlayer", () => {
    it("removes only the named row when given a sanction id", async () => {
      postgres.query.mockResolvedValueOnce([{ id: "sanction-7" }]);

      const result = await service.unsanctionServerPlayer({
        steamId,
        type: "warning",
        sanctionId: "sanction-7",
      });

      expect(postgres.query).toHaveBeenCalledTimes(1);
      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).toContain("WHERE id = $1::uuid");
      expect(sql).toContain("AND player_steam_id = $2::bigint");
      expect(sql).toContain("AND deleted_at IS NULL");
      expect(params).toEqual(["sanction-7", steamId, "warning"]);
      expect(result).toEqual({
        id: "sanction-7",
        enforced: false,
        message: "warning removed",
      });
    });

    it("says so when the named row is not there to remove", async () => {
      postgres.query.mockResolvedValueOnce([]);

      await expect(
        service.unsanctionServerPlayer({
          serverId: "server-1",
          steamId,
          type: "ban",
          sanctionId: "sanction-7",
        }),
      ).rejects.toThrow("sanction not found");

      expect(rconService.connect).not.toHaveBeenCalled();
    });

    it("refuses to clear warnings by type alone", async () => {
      await expect(
        service.unsanctionServerPlayer({ steamId, type: "warning" }),
      ).rejects.toThrow("a warning is removed by its sanction id");

      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("never syncs the server when a warning is removed", async () => {
      postgres.query.mockResolvedValueOnce([{ id: "sanction-7" }]);

      await service.unsanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "warning",
        sanctionId: "sanction-7",
      });

      expect(rconService.connect).not.toHaveBeenCalled();
    });

    it("still clears an enforced type by type and syncs the server", async () => {
      await service.unsanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "mute",
      });

      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).not.toContain("WHERE id =");
      expect(params).toEqual([steamId, "mute"]);
      expect(rcon.send).toHaveBeenCalledWith("get_match");
    });
  });
});
