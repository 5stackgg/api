import { SteamRelay } from "./steam-relay";

const ADDRESS = "[A:1:3653557264:51859]";

// Every plugin's word on Steam's relay lands here, so this is the whole rule:
// the server says whether it is on the relay and where, and nothing else does.
describe("SteamRelay", () => {
  function make() {
    const postgres = { query: jest.fn().mockResolvedValue([]) };
    return { postgres };
  }

  it("reads a body value and a query string the same way", () => {
    expect(SteamRelay.word(true, ADDRESS)).toEqual({
      onRelay: true,
      address: ADDRESS,
    });
    expect(SteamRelay.word("true", ` ${ADDRESS} `)).toEqual({
      onRelay: true,
      address: ADDRESS,
    });
    expect(SteamRelay.word("false", "")).toEqual({
      onRelay: false,
      address: null,
    });
  });

  it("takes a plugin that does not say as not having said", () => {
    expect(SteamRelay.word(undefined, undefined)).toEqual({
      onRelay: null,
      address: null,
    });
    expect(SteamRelay.word("maybe", 42)).toEqual({
      onRelay: null,
      address: null,
    });
  });

  // The address is spliced into the connect command players run.
  it("takes nothing but a Steam ID as an address", () => {
    for (const address of [
      "1.2.3.4:27015",
      `${ADDRESS}; quit`,
      "[A:1:3653557264:51859] ; bind w kill",
      "[A:1:3653557264]",
      "STEAM_1:0:1234",
    ]) {
      expect(SteamRelay.word(true, address)).toEqual({
        onRelay: true,
        address: null,
      });
    }

    expect(SteamRelay.word(true, "[G:1:12345:0]").address).toBe(
      "[G:1:12345:0]",
    );
  });

  it("records the address of a server on the relay", async () => {
    const { postgres } = make();

    await expect(
      SteamRelay.report(postgres as any, "server-1", {
        onRelay: true,
        address: ADDRESS,
      }),
    ).resolves.toBe(true);

    const [[sql, params]] = postgres.query.mock.calls;

    expect(sql).toMatch(/SET steam_relay = \$2/);
    expect(params).toEqual(["server-1", ADDRESS]);
  });

  it("clears the address of a server that says it is off the relay", async () => {
    const { postgres } = make();

    await expect(
      SteamRelay.report(postgres as any, "server-1", {
        onRelay: false,
        address: null,
      }),
    ).resolves.toBe(true);

    const [[sql, params]] = postgres.query.mock.calls;

    expect(sql).toMatch(/SET steam_relay = NULL/);
    expect(params).toEqual(["server-1"]);
  });

  // The only address left to hand out would be a host and port, and on the
  // relay that reaches nobody.
  it("does not call a server up that is on the relay with no address yet", async () => {
    const { postgres } = make();

    await expect(
      SteamRelay.report(postgres as any, "server-1", {
        onRelay: true,
        address: null,
      }),
    ).resolves.toBe(false);

    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("changes nothing for a plugin that does not say", async () => {
    const { postgres } = make();

    await expect(
      SteamRelay.report(postgres as any, "server-1", {
        onRelay: null,
        address: null,
      }),
    ).resolves.toBe(true);

    expect(postgres.query).not.toHaveBeenCalled();
  });
});
