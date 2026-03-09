import { Response } from "express";
import { MatchRelayService } from "./match-relay.service";
import { Fragment } from "./types/fragment.types";

function mockResponse() {
  return {
    writeHead: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
  } as unknown as Response;
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
  });

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
  });

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
  });

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
  });
});
