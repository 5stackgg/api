import { SteamGcConnectionError, SteamGcService } from "./steam-gc.service";
import { ResolveMatchMetadata } from "./jobs/ResolveMatchMetadata";

const mockClients: Array<any> = [];
const mockGcs: Array<any> = [];

jest.mock("steam-user", () => {
  const { EventEmitter } = jest.requireActual("events");

  return class extends EventEmitter {
    static EPersonaState = { Online: 1 };
    logOn = jest.fn();
    logOff = jest.fn();
    setPersona = jest.fn();
    gamesPlayed = jest.fn();

    constructor() {
      super();
      mockClients.push(this);
    }
  };
});

jest.mock("globaloffensive", () => {
  const { EventEmitter } = jest.requireActual("events");

  return class extends EventEmitter {
    requestGame = jest.fn();

    constructor() {
      super();
      mockGcs.push(this);
    }
  };
});

const SHARE_CODE = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";
const MATCH_ID = "3230642215713767580";
const OTHER_SHARE_CODE = "CSGO-vGqmL-vb2x2-nTQtU-e9dco-qWHzN";
const OTHER_MATCH_ID = "3354591898827227340";
const VALVE_MATCH_ID = "1174469974867590708";
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_LOGOFF_MS = 5 * 60_000;

const reply = (matchid: string) => ({
  matchid,
  matchtime: 1700000000,
  watchablematchinfo: { game_map: "de_dust2" },
  roundstatsall: [{ map: `http://replay/${matchid}.dem.bz2` }],
});

const build = () => {
  mockClients.length = 0;
  mockGcs.length = 0;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new SteamGcService(
    logger as never,
    { get: jest.fn(() => "gc-bot") } as never,
    { get: jest.fn(async (): Promise<null> => null), put: jest.fn() } as never,
  );

  const session = () => ({ client: mockClients.at(-1), cs: mockGcs.at(-1) });

  const request = async (shareCode = SHARE_CODE) => {
    const sessions = mockGcs.length;
    const pending = service.resolveShareCode(shareCode);
    pending.catch((): void => undefined);
    await jest.advanceTimersByTimeAsync(0);
    if (mockGcs.length > sessions) {
      session().cs.emit("connectedToGC");
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(session().cs.requestGame).toHaveBeenLastCalledWith(shareCode);
    return { pending };
  };

  return { service, logger, session, request };
};

const resolveJob = (steamGc: SteamGcService) => {
  const failures: Array<Array<unknown>> = [];
  const postgres = {
    query: jest.fn(
      async (sql: string, params: Array<unknown> = []): Promise<unknown[]> => {
        if (sql.includes("SELECT share_code")) {
          return [
            { share_code: SHARE_CODE, demo_url: null, match_start_time: null },
          ];
        }
        if (sql.includes("SET status = 'Failed'")) {
          failures.push(params);
        }
        return [];
      },
    ),
  };
  const job = new ResolveMatchMetadata(
    { log: jest.fn(), warn: jest.fn() } as never,
    postgres as never,
    steamGc,
    {} as never,
    {} as never,
  );

  const run = (attemptsMade: number) => {
    return job.process({
      data: { valve_match_id: VALVE_MATCH_ID },
      attemptsMade,
      opts: { attempts: 5 },
    } as never);
  };

  return { run, failures };
};

describe("SteamGcService.resolveShareCode", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("rejects, so the import is retried, when the session is replaced mid-request", async () => {
    const { request, session } = build();

    const { pending } = await request();
    session().client.emit("error", new Error("LogonSessionReplaced"));

    await expect(pending).rejects.toThrow(
      new SteamGcConnectionError("steam gc session ended before it answered"),
    );
  });

  it("rejects when the GC never answers, and logs in fresh for the retry", async () => {
    const { request, session } = build();

    const { pending } = await request();
    const { client } = session();
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    await expect(pending).rejects.toThrow(
      new SteamGcConnectionError("steam gc did not answer in time"),
    );
    expect(client.logOff).toHaveBeenCalled();

    await request();
    expect(mockClients).toHaveLength(2);
  });

  it.each([
    ["its match", [reply(OTHER_MATCH_ID)]],
    ["no match", []],
  ])(
    "ignores a reply with %s that lands after its request timed out",
    async (_, late) => {
      const { request, session } = build();

      const { pending: first } = await request(OTHER_SHARE_CODE);
      const stale = session().cs;
      await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await expect(first).rejects.toBeInstanceOf(SteamGcConnectionError);

      const { pending: second } = await request(SHARE_CODE);
      stale.emit("matchList", late);
      session().cs.emit("matchList", [reply(MATCH_ID)]);

      await expect(second).resolves.toMatchObject({
        demoUrl: `http://replay/${MATCH_ID}.dem.bz2`,
      });
    },
  );

  it("ignores a reply for another match while waiting for its own", async () => {
    const { request, session } = build();

    const { pending } = await request(SHARE_CODE);
    session().cs.emit("matchList", [reply(OTHER_MATCH_ID)]);
    session().cs.emit("matchList", [reply(MATCH_ID)]);

    await expect(pending).resolves.toMatchObject({
      demoUrl: `http://replay/${MATCH_ID}.dem.bz2`,
      mapName: "de_dust2",
    });
  });

  it("takes the reply for a share code that has CSGO inside it", async () => {
    const { request, session } = build();

    const { pending } = await request("CSGO-dDTOM-tT9ur-wEavE-uqERi-LCSGO");
    session().cs.emit("matchList", [reply("3354591961205914320")]);
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      demoUrl: "http://replay/3354591961205914320.dem.bz2",
    });
  });

  it("returns null when the GC answers without the match", async () => {
    const { request, session } = build();

    const { pending } = await request();
    session().cs.emit("matchList", []);

    await expect(pending).resolves.toBeNull();
  });

  it("rejects the request when the GC reports a logon error", async () => {
    const { request, session } = build();

    const { pending } = await request();

    expect(() => {
      session().cs.emit("error", new Error("Logon Fatal Error: 5"));
    }).not.toThrow();
    await expect(pending).rejects.toThrow(
      new SteamGcConnectionError("steam gc session ended before it answered"),
    );
  });

  it("rejects the connection when the GC reports a logon error before it is ready", async () => {
    const { service, session } = build();

    const pending = service.resolveShareCode(SHARE_CODE);
    pending.catch((): void => undefined);
    await jest.advanceTimersByTimeAsync(0);

    expect(() => {
      session().cs.emit("error", new Error("Logon Fatal Error: 5"));
    }).not.toThrow();
    await expect(pending).rejects.toThrow(
      new SteamGcConnectionError("Logon Fatal Error: 5"),
    );
  });

  it("does not log off in the middle of a request started just before the idle timeout", async () => {
    const { request, session } = build();

    const { pending: first } = await request();
    session().cs.emit("matchList", [reply(MATCH_ID)]);
    await first;

    await jest.advanceTimersByTimeAsync(IDLE_LOGOFF_MS - 1_000);
    const { pending: second } = await request();
    await jest.advanceTimersByTimeAsync(2_000);
    session().cs.emit("matchList", [reply(MATCH_ID)]);

    await expect(second).resolves.toMatchObject({ mapName: "de_dust2" });
    expect(session().client.logOff).not.toHaveBeenCalled();
    expect(mockClients).toHaveLength(1);
  });
});

describe("ResolveMatchMetadata when the GC does not answer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const runUnanswered = async (attemptsMade: number) => {
    const { service, session } = build();
    const { run, failures } = resolveJob(service);

    const pending = run(attemptsMade);
    pending.catch((): void => undefined);
    await jest.advanceTimersByTimeAsync(0);
    session().cs.emit("connectedToGC");
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    return { pending, failures };
  };

  it("leaves the import for the retry while attempts remain", async () => {
    const { pending, failures } = await runUnanswered(0);

    await expect(pending).rejects.toBeInstanceOf(SteamGcConnectionError);
    expect(failures).toEqual([]);
  });

  it("marks the import Failed with the reason on the last attempt", async () => {
    const { pending, failures } = await runUnanswered(4);

    await expect(pending).rejects.toBeInstanceOf(SteamGcConnectionError);
    expect(failures).toEqual([
      [VALVE_MATCH_ID, "steam gc did not answer in time"],
    ]);
  });
});
