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

  describe("syncServerSanctions", () => {
    const heartbeats = () =>
      postgres.query.mock.calls.filter(([sql]) =>
        sql.includes("UPDATE public.servers"),
      );
    const reads = () =>
      postgres.query.mock.calls.filter(([sql]) =>
        sql.includes("FROM public.player_sanctions"),
      );

    it("reads only the enforced types, for only the players it was asked about", async () => {
      await service.syncServerSanctions("server-1", {
        steamIds: [steamId, "76561198000000002"],
      });

      const [sql, params] = reads()[0];
      expect(sql).toContain("type = ANY($1::text[])");
      expect(sql).toContain("player_steam_id = ANY($2::bigint[])");
      expect(params).toEqual([
        ["ban", "mute", "gag", "silence"],
        [steamId, "76561198000000002"],
      ]);
    });

    it("drops anything that is not a steam id, and duplicates", async () => {
      await service.syncServerSanctions("server-1", {
        steamIds: [steamId, steamId, "1; DROP TABLE players", "9".repeat(19)],
      });

      expect(reads()[0][1][1]).toEqual([steamId]);
    });

    it("hands the plugin each sanction with an ISO expiry", async () => {
      postgres.query.mockImplementation(async (sql: string) =>
        sql.includes("FROM public.player_sanctions")
          ? [
              {
                steam_id: steamId,
                type: "silence",
                reason: "spam",
                expires_at: new Date("2026-10-01T00:00:00Z"),
              },
              {
                steam_id: steamId,
                type: "ban",
                reason: null,
                expires_at: null,
              },
            ]
          : [],
      );

      expect(
        await service.syncServerSanctions("server-1", { steamIds: [steamId] }),
      ).toEqual([
        {
          steam_id: steamId,
          type: "silence",
          reason: "spam",
          expires_at: "2026-10-01T00:00:00.000Z",
        },
        { steam_id: steamId, type: "ban", reason: null, expires_at: null },
      ]);
    });

    // An empty server still has to show as running the plugin.
    it("records the heartbeat of an empty server without reading sanctions", async () => {
      expect(
        await service.syncServerSanctions("server-1", {
          steamIds: [],
          pluginVersion: "0.0.412",
          pluginRuntime: "swiftlys2",
        }),
      ).toEqual([]);

      expect(reads()).toHaveLength(0);
      const [sql, params] = heartbeats()[0];
      expect(sql).toContain("player_management_seen_at = now()");
      expect(sql).toContain("interval '60 seconds'");
      expect(params).toEqual(["server-1", "0.0.412", "swiftlys2"]);
    });

    it("records a dev build as dev and an unknown runtime as nothing", async () => {
      await service.syncServerSanctions("server-1", {
        pluginVersion: "__RELEASE_VERSION__",
        pluginRuntime: "metamod",
      });

      expect(heartbeats()[0][1]).toEqual(["server-1", "dev", null]);
    });

    it("still answers when the heartbeat cannot be written", async () => {
      postgres.query.mockImplementation(async (sql: string) => {
        if (sql.includes("UPDATE public.servers")) {
          throw new Error("deadlock");
        }
        return [];
      });

      await expect(
        service.syncServerSanctions("server-1", { steamIds: [steamId] }),
      ).resolves.toEqual([]);
    });
  });

  describe("syncing a community server", () => {
    const replyToRefresh = (reply: string) => {
      rcon.send.mockImplementation(async (command: string) =>
        command === "player_management_refresh" ? reply : "",
      );
    };

    beforeEach(() => {
      hasura.query.mockResolvedValue({
        matches: [],
        servers_by_pk: { is_dedicated: true, type: "Casual", game: "cs2" },
      });
    });

    it("asks the player management plugin to sync instead of the match plugin", async () => {
      replyToRefresh("PlayerManagement: syncing 4 player(s)");

      const result = await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "gag",
        sanctionedBySteamId: moderator,
      });

      expect(rcon.send).toHaveBeenCalledWith("player_management_refresh");
      expect(rcon.send).not.toHaveBeenCalledWith("get_match");
      expect(result).toMatchObject({
        enforced: true,
        message: "sanction saved and synced to server",
      });
    });

    it("says so when the plugin is loaded but not configured", async () => {
      replyToRefresh(
        "PlayerManagement: not configured; set API_DOMAIN, SERVER_ID and SERVER_API_PASSWORD",
      );

      const result = await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "mute",
        sanctionedBySteamId: moderator,
      });

      expect(result).toMatchObject({
        enforced: false,
        message:
          "sanction saved; the Player Management plugin on this server is not configured",
      });
    });

    it("says so when the plugin is not installed", async () => {
      replyToRefresh('Unknown command "player_management_refresh"!');

      const result = await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "mute",
        sanctionedBySteamId: moderator,
      });

      expect(result).toMatchObject({
        enforced: false,
        message:
          "sanction saved; the Player Management plugin is not installed on this server",
      });
    });

    // The kick lands, but nothing stops the player rejoining, so the
    // moderator is told rather than shown a clean success.
    it("does not count a kicked ban as enforced when the plugin is missing", async () => {
      replyToRefresh("");

      const result = await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "ban",
        sanctionedBySteamId: moderator,
      });

      expect(rcon.send).toHaveBeenCalledWith("kickid 4 Banned");
      expect(result).toMatchObject({
        enforced: false,
        message:
          "sanction saved and player kicked; the Player Management plugin is not installed on this server",
      });
    });

    it("keeps the kick in the message when the plugin is not configured", async () => {
      replyToRefresh("PlayerManagement: not configured");

      const result = await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "ban",
        sanctionedBySteamId: moderator,
      });

      expect(result).toMatchObject({
        enforced: false,
        message:
          "sanction saved and player kicked; the Player Management plugin on this server is not configured",
      });
    });

    it("words a lifted sanction as removed, not saved", async () => {
      replyToRefresh("");

      const result = await service.unsanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "mute",
      });

      expect(result).toMatchObject({
        enforced: false,
        message:
          "sanction removed; the Player Management plugin is not installed on this server",
      });
    });

    it("never asks a CS:GO server for the CS2-only plugin", async () => {
      hasura.query.mockResolvedValue({
        matches: [],
        servers_by_pk: { is_dedicated: true, type: "Casual", game: "csgo" },
      });

      const result = await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "mute",
        sanctionedBySteamId: moderator,
      });

      expect(rcon.send).not.toHaveBeenCalledWith("player_management_refresh");
      expect(result).toMatchObject({
        enforced: false,
        message: "sanction saved; server has no match to sync",
      });
    });

    it("refreshes the plugin when a sanction is lifted", async () => {
      replyToRefresh("PlayerManagement: syncing 1 player(s)");

      const result = await service.unsanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "gag",
      });

      expect(rcon.send).toHaveBeenCalledWith("player_management_refresh");
      expect(result.enforced).toBe(true);
    });

    it("leaves a Ranked server with no match alone", async () => {
      hasura.query.mockResolvedValue({
        matches: [],
        servers_by_pk: { is_dedicated: true, type: "Ranked", game: "cs2" },
      });

      const result = await service.sanctionServerPlayer({
        serverId: "server-1",
        steamId,
        type: "mute",
        sanctionedBySteamId: moderator,
      });

      expect(rcon.send).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        enforced: false,
        message: "sanction saved; server has no match to sync",
      });
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
