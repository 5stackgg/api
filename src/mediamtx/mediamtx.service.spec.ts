import { Logger } from "@nestjs/common";
import { MediaMtxService } from "./mediamtx.service";

describe("MediaMtxService", () => {
  let service: MediaMtxService;

  beforeEach(() => {
    service = new MediaMtxService(new Logger("MediaMtxTest"));
  });

  // The prefix is the only place the purpose of a path exists -- MediaMTX has
  // no notion of what a path is for.
  describe("kindForPath", () => {
    it.each([
      ["voice-11111111-1111-1111-1111-111111111111-76561198000000001", "voice"],
      [
        "voicecam-11111111-1111-1111-1111-111111111111-76561198000000001",
        "videoCalls",
      ],
      [
        "camera-11111111-1111-1111-1111-111111111111-76561198000000001",
        "playerCameras",
      ],
      [
        "camera-talk-11111111-1111-1111-1111-111111111111-76561198000000001",
        "cameraTalkback",
      ],
      ["match-abc-stream", "gameStreams"],
      ["anything-else", "gameStreams"],
    ])("reads %s as %s", (path, expected) => {
      expect(MediaMtxService.kindForPath(path)).toBe(expected);
    });

    // `camera-` is a prefix of `camera-talk-`, and `voice-` all but one
    // character of `voicecam-`. Checked in the wrong order, talk-back counts as
    // a player camera and every video call counts as voice -- which would make
    // the busiest row on the admin view the wrong one.
    it("does not let a prefix swallow the longer name it starts", () => {
      expect(MediaMtxService.kindForPath("camera-talk-x-1")).not.toBe(
        "playerCameras",
      );
      expect(MediaMtxService.kindForPath("voicecam-x-1")).not.toBe("voice");
    });
  });

  describe("stats", () => {
    const paths = (
      entries: Array<[string, { ready: boolean; bytesReceived: number }]>,
    ) => new Map(entries);

    it("counts paths and bytes into the kind each one belongs to", async () => {
      jest.spyOn(service, "listPaths").mockResolvedValue(
        paths([
          ["voice-a-1", { ready: true, bytesReceived: 100 }],
          ["voice-a-2", { ready: false, bytesReceived: 0 }],
          ["voicecam-a-1", { ready: true, bytesReceived: 900 }],
          ["camera-m-1", { ready: true, bytesReceived: 50 }],
          ["camera-talk-m-1", { ready: true, bytesReceived: 5 }],
          ["some-game-stream", { ready: true, bytesReceived: 9000 }],
        ]),
      );
      jest
        .spyOn(service as any, "listWebrtcSessions")
        .mockResolvedValue(12);

      const stats = await service.stats();

      expect(stats).not.toBeNull();
      expect(stats!.paths).toBe(6);
      // A path can exist without a live publisher, so these differ on purpose.
      expect(stats!.ready).toBe(5);
      expect(stats!.webrtcSessions).toBe(12);

      expect(stats!.byKind.voice).toEqual({
        paths: 2,
        ready: 1,
        bytesReceived: 100,
      });
      expect(stats!.byKind.videoCalls).toEqual({
        paths: 1,
        ready: 1,
        bytesReceived: 900,
      });
      expect(stats!.byKind.playerCameras.paths).toBe(1);
      expect(stats!.byKind.cameraTalkback.paths).toBe(1);
      expect(stats!.byKind.gameStreams.bytesReceived).toBe(9000);
    });

    // An outage drawn as an idle server is worse than a gap: the admin view has
    // to be able to say "unknown" rather than a zero it never measured.
    it("returns null when mediamtx does not answer", async () => {
      jest.spyOn(service, "listPaths").mockResolvedValue(null);

      await expect(service.stats()).resolves.toBeNull();
    });

    // Paths answered, sessions did not. Everything else is still real, so the
    // whole response must not be thrown away over the one field.
    it("keeps the path numbers when only the session count is unavailable", async () => {
      jest
        .spyOn(service, "listPaths")
        .mockResolvedValue(paths([["voice-a-1", { ready: true, bytesReceived: 1 }]]));
      jest
        .spyOn(service as any, "listWebrtcSessions")
        .mockResolvedValue(null);

      const stats = await service.stats();

      expect(stats!.paths).toBe(1);
      expect(stats!.webrtcSessions).toBeNull();
    });

    it("reports every kind even when nothing is publishing", async () => {
      jest.spyOn(service, "listPaths").mockResolvedValue(paths([]));
      jest.spyOn(service as any, "listWebrtcSessions").mockResolvedValue(0);

      const stats = await service.stats();

      expect(Object.keys(stats!.byKind).sort()).toEqual([
        "cameraTalkback",
        "gameStreams",
        "playerCameras",
        "videoCalls",
        "voice",
      ]);
      expect(stats!.paths).toBe(0);
    });
  });
});
