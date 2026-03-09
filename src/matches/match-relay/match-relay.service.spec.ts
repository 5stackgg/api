import { Request, Response } from "express";
import { MatchRelayService } from "./match-relay.service";
import { Fragment } from "./types/fragment.types";
import { EventEmitter } from "events";

function mockResponse() {
  return {
    writeHead: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
  } as unknown as Response;
}

function mockRequest(
  overrides: { query?: Record<string, string> } = {},
): Request & EventEmitter {
  const emitter = new EventEmitter();
  (emitter as any).query = overrides.query || {};
  return emitter as unknown as Request & EventEmitter;
}

function makeSyncReadyFragment(
  tick: number,
  endtick: number,
  timestamp?: number,
): Fragment {
  return {
    full: { data: Buffer.from("f"), tick },
    delta: {
      data: Buffer.from("d"),
      tick,
      endtick,
      timestamp: timestamp ?? Date.now(),
    },
  };
}

describe("MatchRelayService", () => {
  let service: MatchRelayService;
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };

  beforeEach(() => {
    service = new MatchRelayService(logger as any);
  });

  // ── removeBroadcast ──────────────────────────────────────────────────
  describe("removeBroadcast", () => {
    it("deletes broadcast entry from internal map", () => {
      const broadcasts = (service as any).broadcasts;
      broadcasts["match-1"] = {
        steamId: "steam1",
        masterCookie: "cookie1",
        fragments: new Map(),
      };

      service.removeBroadcast("match-1");

      expect(broadcasts["match-1"]).toBeUndefined();
    });
  });

  // ── getStart ─────────────────────────────────────────────────────────
  describe("getStart", () => {
    it("returns 404 when broadcast or start fragment missing", () => {
      const res = mockResponse();

      service.getStart(res, "non-existent-match", 0);

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        "X-Reason":
          "Invalid or expired start fragment, please re-sync",
      });
      expect(res.end).toHaveBeenCalled();
    });

    it("serves blob when start fragment matches fragmentIndex", () => {
      const buf = Buffer.from("start-data");
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, {
        start: {
          signup_fragment: 0,
          data: buf,
        },
      });
      broadcasts["match-1"] = {
        steamId: "steam1",
        masterCookie: "cookie1",
        fragments,
      };

      const res = mockResponse();
      service.getStart(res, "match-1", 0);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/octet-stream",
      });
      expect(res.end).toHaveBeenCalledWith(buf);
    });

    it("returns 404 when signup_fragment does not match requested index", () => {
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, {
        start: { signup_fragment: 3, data: Buffer.from("x") },
      });
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const res = mockResponse();
      service.getStart(res, "match-1", 0);

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        "X-Reason":
          "Invalid or expired start fragment, please re-sync",
      });
    });

    it("serves gzipped start blob with Content-Encoding header", () => {
      const buf = Buffer.from("gzipped-start");
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, {
        start: { signup_fragment: 0, data: buf, gipped: true },
      });
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const res = mockResponse();
      service.getStart(res, "match-1", 0);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "gzip",
      });
      expect(res.end).toHaveBeenCalledWith(buf);
    });
  });

  // ── getFragment ──────────────────────────────────────────────────────
  describe("getFragment", () => {
    it("returns 404 when broadcast not found", () => {
      const res = mockResponse();

      service.getFragment(res, "no-match", 1, "full");

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        "X-Reason": "broadcast not found",
      });
      expect(res.end).toHaveBeenCalled();
    });

    it("returns 404 when fragment not found", () => {
      const broadcasts = (service as any).broadcasts;
      broadcasts["match-1"] = {
        steamId: "steam1",
        masterCookie: "cookie1",
        fragments: new Map<number, Fragment>(),
      };

      const res = mockResponse();
      service.getFragment(res, "match-1", 99, "full");

      expect(res.writeHead).toHaveBeenCalledWith(404, "fragment not found");
      expect(res.end).toHaveBeenCalled();
    });

    it("serves blob for valid fragment and field", () => {
      const buf = Buffer.from("full-data");
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(5, {
        full: { data: buf },
      });
      broadcasts["match-1"] = {
        steamId: "steam1",
        masterCookie: "cookie1",
        fragments,
      };

      const res = mockResponse();
      service.getFragment(res, "match-1", 5, "full");

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/octet-stream",
      });
      expect(res.end).toHaveBeenCalledWith(buf);
    });

    it("returns 404 when field has no data", () => {
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(5, { full: { tick: 100 } }); // no .data
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const res = mockResponse();
      service.getFragment(res, "match-1", 5, "full");

      expect(res.writeHead).toHaveBeenCalledWith(404, "Field not found");
      expect(res.end).toHaveBeenCalled();
    });

    it("serves delta field correctly", () => {
      const buf = Buffer.from("delta-data");
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(3, { delta: { data: buf, gipped: true } });
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const res = mockResponse();
      service.getFragment(res, "match-1", 3, "delta");

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "gzip",
      });
      expect(res.end).toHaveBeenCalledWith(buf);
    });
  });

  // ── getSyncInfo ──────────────────────────────────────────────────────
  describe("getSyncInfo", () => {
    it("returns 404 when broadcast not found", () => {
      const req = mockRequest();
      const res = mockResponse();

      service.getSyncInfo(req as any, res, "missing");

      expect(res.setHeader).toHaveBeenCalledWith(
        "Cache-Control",
        "public, max-age=3",
      );
      expect(res.writeHead).toHaveBeenCalledWith(404, {
        "X-Reason": "broadcast not found",
      });
    });

    it("returns 404 when start fragment has no data", () => {
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, { start: {} }); // no data
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const req = mockRequest();
      const res = mockResponse();
      service.getSyncInfo(req as any, res, "match-1");

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        "X-Reason": "broadcast has not started yet",
      });
    });

    it("returns 404 when start fragment is missing entirely", () => {
      const broadcasts = (service as any).broadcasts;
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments: new Map<number, Fragment>(),
      };

      const req = mockRequest();
      const res = mockResponse();
      service.getSyncInfo(req as any, res, "match-1");

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        "X-Reason": "broadcast has not started yet",
      });
    });

    it("returns 405 when no sync-ready fragment exists (no fragment param)", () => {
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, {
        start: { data: Buffer.from("s"), signup_fragment: 0 },
      });
      // fragment 1 exists but is not sync-ready (missing delta)
      fragments.set(1, { full: { data: Buffer.from("f"), tick: 10 } });
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const req = mockRequest();
      const res = mockResponse();
      service.getSyncInfo(req as any, res, "match-1");

      expect(res.writeHead).toHaveBeenCalledWith(405, {
        "X-Reason": "fragment not found, please check back soon",
      });
    });

    it("returns valid sync JSON without fragment param", () => {
      const now = Date.now();
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, {
        start: {
          data: Buffer.from("s"),
          signup_fragment: 0,
          tps: 64,
          keyframe_interval: 3,
          map: "de_dust2",
        },
      });
      // Add several sync-ready fragments
      for (let i = 1; i <= 10; i++) {
        fragments.set(i, makeSyncReadyFragment(i * 100, i * 100 + 50, now));
      }
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const req = mockRequest();
      const res = mockResponse();
      service.getSyncInfo(req as any, res, "match-1");

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/json",
      });

      const body = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
      // maxIndex=10, so fragment should be max(0, 10-7)=3
      expect(body.fragment).toBe(3);
      expect(body.tick).toBe(300);
      expect(body.endtick).toBe(350);
      expect(body.signup_fragment).toBe(0);
      expect(body.tps).toBe(64);
      expect(body.keyframe_interval).toBe(3);
      expect(body.map).toBe("de_dust2");
      expect(body.protocol).toBe(5); // default
    });

    it("returns valid sync JSON with fragment query param", () => {
      const now = Date.now();
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, {
        start: {
          data: Buffer.from("s"),
          signup_fragment: 0,
          tps: 64,
          map: "de_mirage",
          protocol: 4,
        },
      });
      for (let i = 1; i <= 5; i++) {
        fragments.set(i, makeSyncReadyFragment(i * 50, i * 50 + 25, now));
      }
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const req = mockRequest({ query: { fragment: "2" } });
      const res = mockResponse();
      service.getSyncInfo(req as any, res, "match-1");

      const body = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
      expect(body.fragment).toBe(2);
      expect(body.tick).toBe(100);
      expect(body.protocol).toBe(4); // preserved from start
    });

    it("clamps fragment param to signup_fragment when lower", () => {
      const now = Date.now();
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, {
        start: { data: Buffer.from("s"), signup_fragment: 3 },
      });
      for (let i = 3; i <= 8; i++) {
        fragments.set(i, makeSyncReadyFragment(i * 10, i * 10 + 5, now));
      }
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const req = mockRequest({ query: { fragment: "1" } });
      const res = mockResponse();
      service.getSyncInfo(req as any, res, "match-1");

      const body = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
      // requested 1 but signup_fragment=3, so clamped up; first sync-ready from 3
      expect(body.fragment).toBe(3);
    });

    it("skips non-sync-ready fragments with fragment param and finds next ready one", () => {
      const now = Date.now();
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, {
        start: { data: Buffer.from("s"), signup_fragment: 0 },
      });
      // fragment 2 is NOT sync-ready
      fragments.set(2, { full: { data: Buffer.from("f"), tick: 200 } });
      // fragment 3 IS sync-ready
      fragments.set(3, makeSyncReadyFragment(300, 350, now));
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      const req = mockRequest({ query: { fragment: "2" } });
      const res = mockResponse();
      service.getSyncInfo(req as any, res, "match-1");

      const body = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
      expect(body.fragment).toBe(3);
    });

    it("sets Expires header roughly 3s into the future", () => {
      const broadcasts = (service as any).broadcasts;
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments: new Map(),
      };

      const req = mockRequest();
      const res = mockResponse();
      service.getSyncInfo(req as any, res, "match-1");

      expect(res.setHeader).toHaveBeenCalledWith(
        "Expires",
        expect.any(String),
      );
    });
  });

  // ── postField ────────────────────────────────────────────────────────
  describe("postField", () => {
    it("creates a new broadcast when one does not exist", () => {
      const broadcasts = (service as any).broadcasts;
      const req = mockRequest();
      const res = mockResponse();

      // token.split("t") => ["76561100", "oken123"]
      service.postField(
        req as any,
        res,
        "76561100token123",
        "start",
        "match-1",
        0,
      );

      expect(broadcasts["match-1"]).toBeDefined();
      expect(broadcasts["match-1"].steamId).toBe("76561100");
      expect(broadcasts["match-1"].masterCookie).toBe("oken123");
    });

    it("clears fragments when token changes (steamId mismatch)", () => {
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, { start: { data: Buffer.from("old") } });
      fragments.set(1, { full: { data: Buffer.from("old-full") } });
      broadcasts["match-1"] = {
        steamId: "old",
        masterCookie: "cookie1",
        fragments,
      };

      // "newtcookie1" splits on first "t" => ["new", "cookie1"]
      const req = mockRequest();
      const res = mockResponse();
      service.postField(
        req as any,
        res,
        "newtcookie1",
        "start",
        "match-1",
        0,
      );

      expect(broadcasts["match-1"].steamId).toBe("new");
      expect(broadcasts["match-1"].masterCookie).toBe("cookie1");
      // fragments were cleared (steamId changed) then one new fragment added
      expect(broadcasts["match-1"].fragments.size).toBe(1);
    });

    it("clears fragments when token changes (masterCookie mismatch)", () => {
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(0, { start: { data: Buffer.from("old") } });
      broadcasts["match-1"] = {
        steamId: "same",
        masterCookie: "oldcookie",
        fragments,
      };

      // "sametnewcookie" splits on first "t" => ["same", "newcookie"]
      const req = mockRequest();
      const res = mockResponse();
      service.postField(
        req as any,
        res,
        "sametnewcookie",
        "start",
        "match-1",
        0,
      );

      expect(broadcasts["match-1"].masterCookie).toBe("newcookie");
      // fragments were cleared then re-populated for fragment 0
      expect(broadcasts["match-1"].fragments.size).toBe(1);
    });

    it("forces fragmentIndex to 0 for start field", () => {
      const broadcasts = (service as any).broadcasts;
      const req = mockRequest();
      const res = mockResponse();

      service.postField(
        req as any,
        res,
        "stcook",
        "start",
        "match-1",
        99, // should be overridden to 0
      );

      expect(broadcasts["match-1"].fragments.has(0)).toBe(true);
      expect(broadcasts["match-1"].fragments.has(99)).toBe(false);
    });

    it("returns 205 when posting non-start field without existing start fragment", () => {
      const res = mockResponse();
      const req = mockRequest();

      service.postField(
        req as any,
        res,
        "stcook",
        "full",
        "match-1",
        5,
      );

      expect(res.writeHead).toHaveBeenCalledWith(205);
      expect(res.end).toHaveBeenCalled();
    });

    it("returns 205 for delta field when no start exists", () => {
      const res = mockResponse();
      const req = mockRequest();

      service.postField(
        req as any,
        res,
        "stcook",
        "delta",
        "match-1",
        3,
      );

      expect(res.writeHead).toHaveBeenCalledWith(205);
      expect(res.end).toHaveBeenCalled();
    });

    it("gzips incoming body and stores it", async () => {
      // First create the start fragment so that subsequent fields are accepted
      const broadcasts = (service as any).broadcasts;
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "cook",
        fragments: new Map<number, Fragment>([[0, { start: { data: Buffer.from("s") } }]]),
      };

      const req = mockRequest({ query: { tick: "100" } });
      const res = mockResponse();

      service.postField(
        req as any,
        res,
        "stcook",
        "full",
        "match-1",
        5,
      );

      expect(res.writeHead).toHaveBeenCalledWith(200);

      // Simulate request body streaming
      const rawData = Buffer.from("hello-fragment-data");
      req.emit("data", rawData);
      req.emit("end");

      // Wait for gzip promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 50));

      const fragment = broadcasts["match-1"].fragments.get(5);
      expect(fragment).toBeDefined();
      expect(fragment.full.data).toBeDefined();
      expect(fragment.full.gipped).toBe(true);
      expect(fragment.full.tick).toBe("100"); // from query params
      expect(fragment.full.timestamp).toBeDefined();
      expect(res.end).toHaveBeenCalled();
    });

    it("stores raw buffer when gzip fails", async () => {
      const broadcasts = (service as any).broadcasts;
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "cook",
        fragments: new Map<number, Fragment>([[0, { start: { data: Buffer.from("s") } }]]),
      };

      // Force gzip to fail
      const originalGzip = (service as any).gzip;
      (service as any).gzip = jest.fn().mockRejectedValue(new Error("gzip fail"));

      const req = mockRequest();
      const res = mockResponse();

      service.postField(
        req as any,
        res,
        "stcook",
        "delta",
        "match-1",
        2,
      );

      const rawData = Buffer.from("raw-delta");
      req.emit("data", rawData);
      req.emit("end");

      await new Promise((resolve) => setTimeout(resolve, 50));

      const fragment = broadcasts["match-1"].fragments.get(2);
      expect(fragment.delta.data).toEqual(rawData);
      expect(fragment.delta.gipped).toBe(false);
      expect(logger.error).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();

      // Restore
      (service as any).gzip = originalGzip;
    });

    it("sets signup_fragment on start field fragment", async () => {
      const req = mockRequest({ query: { tps: "64", map: "de_dust2" } });
      const res = mockResponse();

      service.postField(
        req as any,
        res,
        "stcook",
        "start",
        "match-1",
        5, // will be overridden to 0
      );

      const broadcasts = (service as any).broadcasts;
      const fragment = broadcasts["match-1"].fragments.get(0);
      // signup_fragment is set based on fragmentIndex (which was set to 0 for start)
      expect(fragment.start.signup_fragment).toBe(0);
      expect(fragment.start.tps).toBe("64");
      expect(fragment.start.map).toBe("de_dust2");
    });

    it("copies all query params into the fragment field", () => {
      const broadcasts = (service as any).broadcasts;
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "cook",
        fragments: new Map<number, Fragment>([[0, { start: { data: Buffer.from("s") } }]]),
      };

      const req = mockRequest({
        query: { tick: "200", endtick: "250", custom: "val" },
      });
      const res = mockResponse();

      service.postField(
        req as any,
        res,
        "stcook",
        "full",
        "match-1",
        7,
      );

      const fragment = broadcasts["match-1"].fragments.get(7);
      expect(fragment.full.tick).toBe("200");
      expect(fragment.full.endtick).toBe("250");
      expect(fragment.full.custom).toBe("val");
    });

    it("calls cleanupOldFragments after storing data", async () => {
      const broadcasts = (service as any).broadcasts;
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "cook",
        fragments: new Map<number, Fragment>([[0, { start: { data: Buffer.from("s") } }]]),
      };

      const cleanupSpy = jest.spyOn(service as any, "cleanupOldFragments");

      const req = mockRequest();
      const res = mockResponse();
      service.postField(req as any, res, "stcook", "full", "match-1", 1);

      req.emit("data", Buffer.from("x"));
      req.emit("end");

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(cleanupSpy).toHaveBeenCalledWith("match-1");
    });
  });

  // ── isSyncReady ──────────────────────────────────────────────────────
  describe("isSyncReady", () => {
    it("requires full.data, delta.data, tick, endtick, timestamp", () => {
      const isSyncReady = (f: Fragment | undefined) =>
        (service as any).isSyncReady(f);

      const complete: Fragment = {
        full: { data: Buffer.from("f"), tick: 100 },
        delta: {
          data: Buffer.from("d"),
          tick: 100,
          endtick: 200,
          timestamp: Date.now(),
        },
      };
      expect(isSyncReady(complete)).toBe(true);

      expect(isSyncReady(undefined)).toBe(false);

      expect(
        isSyncReady({
          full: { tick: 100 },
          delta: {
            data: Buffer.from("d"),
            endtick: 200,
            timestamp: Date.now(),
          },
        }),
      ).toBe(false);

      expect(
        isSyncReady({
          full: { data: Buffer.from("f"), tick: 100 },
          delta: { endtick: 200, timestamp: Date.now() },
        }),
      ).toBe(false);

      expect(
        isSyncReady({
          full: { data: Buffer.from("f"), tick: 100 },
          delta: { data: Buffer.from("d"), timestamp: Date.now() },
        }),
      ).toBe(false);

      expect(
        isSyncReady({
          full: { data: Buffer.from("f"), tick: 100 },
          delta: { data: Buffer.from("d"), endtick: 200 },
        }),
      ).toBe(false);
    });

    it("accepts delta.tick as alternative to full.tick", () => {
      const isSyncReady = (f: Fragment | undefined) =>
        (service as any).isSyncReady(f);

      expect(
        isSyncReady({
          full: { data: Buffer.from("f") }, // no tick on full
          delta: {
            data: Buffer.from("d"),
            tick: 50,
            endtick: 100,
            timestamp: Date.now(),
          },
        }),
      ).toBe(true);
    });

    it("returns false when neither full.tick nor delta.tick is present", () => {
      const isSyncReady = (f: Fragment | undefined) =>
        (service as any).isSyncReady(f);

      expect(
        isSyncReady({
          full: { data: Buffer.from("f") },
          delta: {
            data: Buffer.from("d"),
            endtick: 100,
            timestamp: Date.now(),
          },
        }),
      ).toBe(false);
    });

    it("returns false for empty fragment object", () => {
      expect((service as any).isSyncReady({})).toBe(false);
    });
  });

  // ── cleanupOldFragments ──────────────────────────────────────────────
  describe("cleanupOldFragments", () => {
    it("removes fragments older than 60s but preserves index 0", () => {
      const broadcasts = (service as any).broadcasts;
      const now = Date.now();
      const fragments = new Map<number, Fragment>();

      fragments.set(0, {
        delta: { timestamp: now - 120000 },
      });

      fragments.set(5, {
        delta: { timestamp: now - 90000 },
      });

      fragments.set(10, {
        delta: { timestamp: now - 5000 },
      });

      broadcasts["match-1"] = {
        steamId: "steam1",
        masterCookie: "cookie1",
        fragments,
      };

      (service as any).cleanupOldFragments("match-1");

      expect(fragments.has(0)).toBe(true);
      expect(fragments.has(5)).toBe(false);
      expect(fragments.has(10)).toBe(true);
    });

    it("does nothing when broadcast does not exist", () => {
      // Should not throw
      expect(() =>
        (service as any).cleanupOldFragments("non-existent"),
      ).not.toThrow();
    });

    it("preserves fragments without a delta timestamp", () => {
      const broadcasts = (service as any).broadcasts;
      const fragments = new Map<number, Fragment>();
      fragments.set(1, { full: { data: Buffer.from("x") } }); // no delta.timestamp
      fragments.set(2, { delta: { timestamp: Date.now() - 90000 } }); // old
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      (service as any).cleanupOldFragments("match-1");

      expect(fragments.has(1)).toBe(true); // kept because no timestamp
      expect(fragments.has(2)).toBe(false); // removed because old
    });

    it("keeps all fragments when none are older than 60s", () => {
      const broadcasts = (service as any).broadcasts;
      const now = Date.now();
      const fragments = new Map<number, Fragment>();
      fragments.set(0, { delta: { timestamp: now } });
      fragments.set(1, { delta: { timestamp: now - 30000 } });
      fragments.set(2, { delta: { timestamp: now - 59000 } });
      broadcasts["match-1"] = {
        steamId: "s",
        masterCookie: "c",
        fragments,
      };

      (service as any).cleanupOldFragments("match-1");

      expect(fragments.size).toBe(3);
    });
  });

  // ── getMatchBroadcastEndTick ─────────────────────────────────────────
  describe("getMatchBroadcastEndTick", () => {
    it("returns 0 for empty map", () => {
      const result = (service as any).getMatchBroadcastEndTick(
        new Map<number, Fragment>(),
      );
      expect(result).toBe(0);
    });

    it("returns highest endtick from fragments (by descending key order)", () => {
      const fragments = new Map<number, Fragment>();
      fragments.set(1, { delta: { endtick: 100 } });
      fragments.set(5, { delta: { endtick: 500 } });
      fragments.set(3, { delta: { endtick: 300 } });

      const result = (service as any).getMatchBroadcastEndTick(fragments);
      // Sorted descending: 5,3,1 -> first with endtick is 5 -> 500
      expect(result).toBe(500);
    });

    it("skips fragments without delta.endtick and returns next one", () => {
      const fragments = new Map<number, Fragment>();
      fragments.set(10, { full: { tick: 999 } }); // no delta.endtick
      fragments.set(7, { delta: { endtick: 700 } });
      fragments.set(3, { delta: { endtick: 300 } });

      const result = (service as any).getMatchBroadcastEndTick(fragments);
      // 10 has no endtick, so 7 is returned
      expect(result).toBe(700);
    });

    it("returns 0 when no fragment has delta.endtick", () => {
      const fragments = new Map<number, Fragment>();
      fragments.set(1, { full: { tick: 100 } });
      fragments.set(2, { delta: {} });

      const result = (service as any).getMatchBroadcastEndTick(fragments);
      expect(result).toBe(0);
    });
  });

  // ── getLastFragment ──────────────────────────────────────────────────
  describe("getLastFragment", () => {
    it("returns undefined for empty map", () => {
      const result = (service as any).getLastFragment(
        new Map<number, Fragment>(),
      );
      expect(result).toBeUndefined();
    });

    it("returns the fragment with the highest numeric key", () => {
      const fragments = new Map<number, Fragment>();
      const frag1: Fragment = { full: { tick: 100 } };
      const frag5: Fragment = { delta: { endtick: 500 } };
      const frag3: Fragment = { full: { tick: 300 } };
      fragments.set(1, frag1);
      fragments.set(5, frag5);
      fragments.set(3, frag3);

      const result = (service as any).getLastFragment(fragments);
      expect(result).toBe(frag5);
    });

    it("returns single element map correctly", () => {
      const fragments = new Map<number, Fragment>();
      const frag: Fragment = { start: { data: Buffer.from("x") } };
      fragments.set(0, frag);

      const result = (service as any).getLastFragment(fragments);
      expect(result).toBe(frag);
    });
  });

  // ── serveBlob ────────────────────────────────────────────────────────
  describe("serveBlob", () => {
    it("returns 404 when fragment is undefined", () => {
      const res = mockResponse();
      (service as any).serveBlob(res, undefined, "full");

      expect(res.writeHead).toHaveBeenCalledWith(404, "Field not found");
      expect(res.end).toHaveBeenCalled();
    });

    it("returns 404 when field data is missing", () => {
      const res = mockResponse();
      (service as any).serveBlob(res, { full: {} }, "full");

      expect(res.writeHead).toHaveBeenCalledWith(404, "Field not found");
    });

    it("returns 404 when field does not exist on fragment", () => {
      const res = mockResponse();
      (service as any).serveBlob(res, { full: { data: Buffer.from("x") } }, "delta");

      expect(res.writeHead).toHaveBeenCalledWith(404, "Field not found");
    });

    it("serves blob without Content-Encoding when not gzipped", () => {
      const buf = Buffer.from("raw-data");
      const res = mockResponse();
      (service as any).serveBlob(res, { full: { data: buf } }, "full");

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/octet-stream",
      });
      expect(res.end).toHaveBeenCalledWith(buf);
    });

    it("serves blob with Content-Encoding when gzipped", () => {
      const buf = Buffer.from("compressed");
      const res = mockResponse();
      (service as any).serveBlob(
        res,
        { delta: { data: buf, gipped: true } },
        "delta",
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "gzip",
      });
      expect(res.end).toHaveBeenCalledWith(buf);
    });

    it("does not set Content-Encoding when gipped is false", () => {
      const buf = Buffer.from("not-compressed");
      const res = mockResponse();
      (service as any).serveBlob(
        res,
        { full: { data: buf, gipped: false } },
        "full",
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/octet-stream",
      });
    });
  });

  // ── relayError ───────────────────────────────────────────────────────
  describe("relayError", () => {
    it("sets X-Reason header and ends response", () => {
      const res = mockResponse();
      (service as any).relayError(res, 503, "server busy");

      expect(res.writeHead).toHaveBeenCalledWith(503, {
        "X-Reason": "server busy",
      });
      expect(res.end).toHaveBeenCalled();
    });
  });
});
