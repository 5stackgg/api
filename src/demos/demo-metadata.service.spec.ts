import zlib from "zlib";
import { Logger } from "@nestjs/common";
import {
  DEMO_METADATA_VERSION,
  DemoMetadataService,
  DemoRow,
  PlaybackBlob,
} from "./demo-metadata.service";
import { ParsedDemo } from "./demo-parser.service";

describe("DemoMetadataService.uploadPlaybackBlob", () => {
  // What the parser hands over for one map, trimmed to the fields the blob
  // reshapes.
  const parsed: ParsedDemo = {
    schema_version: 3,
    total_ticks: 27588,
    tick_rate: 64,
    map_name: "de_inferno",
    round_ticks: [],
    kills: [],
    bombs: [],
    damages: [
      {
        tick: 1941,
        round: 1,
        attacker: "76561198094364763",
        victim: "76561198021949067",
        weapon: "ak47",
        damage: 27,
        damage_armor: 4,
        hitgroup: 2,
        health: 73,
      },
      {
        tick: 1964,
        round: 1,
        attacker: "76561198094364763",
        victim: "76561198021949067",
        damage: 23,
      },
    ],
    flashes: [
      {
        tick: 5100,
        round: 2,
        attacker: "76561198094364763",
        attacker_team: "t",
        victim: "76561198021949067",
        victim_team: "ct",
        duration: 2.35,
      },
      {
        tick: 5101,
        round: 2,
        attacker: "76561198094364763",
        victim: "76561198094364764",
        duration: 0.8,
        team_flash: true,
      },
    ],
    smoke_voxels: [
      {
        gid: 1,
        round: 2,
        start_tick: 4019,
        end_tick: 4381,
        ox: -92.33742,
        oy: 1250.2552,
        oz: 106.03123,
        vs: 20,
        dx: 2,
        dy: 1,
        dz: 1,
        arr: Buffer.from([0, 255]).toString("base64"),
      },
    ],
  };

  async function upload(demo: ParsedDemo) {
    const put = jest.fn<Promise<void>, [string, Buffer]>(async () => {});
    const query = jest.fn<Promise<Array<unknown>>, [string, Array<unknown>]>(
      async () => [],
    );
    const service = new DemoMetadataService(
      new Logger("DemoMetadataTest"),
      null as never,
      { query } as never,
      { put } as never,
      null as never,
      null as never,
      null as never,
    );

    const key = await service.uploadPlaybackBlob("match", "map", "demo", demo);
    const [, body] = put.mock.calls[0];
    const blob = JSON.parse(
      zlib.gunzipSync(body).toString("utf8"),
    ) as PlaybackBlob;

    return { key, blob, query };
  }

  it("stores the blob under the current version", async () => {
    const { key, blob, query } = await upload(parsed);

    expect(DEMO_METADATA_VERSION).toBe(11);
    expect(key).toContain(`/playback.v${DEMO_METADATA_VERSION}.`);
    expect(blob.schema_version).toBe(DEMO_METADATA_VERSION);
    expect(blob.parser_schema_version).toBe(3);
    expect(query.mock.calls[0][1]).toEqual(
      expect.arrayContaining([DEMO_METADATA_VERSION, 3]),
    );
  });

  it("carries the smoke voxel grids through untouched", async () => {
    const { blob } = await upload(parsed);

    expect(blob.smoke_voxels).toEqual(parsed.smoke_voxels);
  });

  it("keeps weapon, hitgroup and armor damage on each damage", async () => {
    const { blob } = await upload(parsed);

    expect(blob.damages).toEqual([
      {
        round: 1,
        time: "1941",
        attacker_steam_id: "76561198094364763",
        attacked_steam_id: "76561198021949067",
        weapon: "ak47",
        hitgroup: 2,
        damage: 27,
        damage_armor: 4,
        health: 73,
      },
      // The parser drops zero values: no hitgroup is generic (0) and no armor
      // figure is no armor damage.
      {
        round: 1,
        time: "1964",
        attacker_steam_id: "76561198094364763",
        attacked_steam_id: "76561198021949067",
        weapon: null,
        hitgroup: 0,
        damage: 23,
        damage_armor: 0,
        health: null,
      },
    ]);
  });

  it("emits every flash with who, how long and whether it was a team flash", async () => {
    const { blob } = await upload(parsed);

    expect(blob.flashes).toEqual([
      {
        round: 2,
        tick: 5100,
        attacker_steam_id: "76561198094364763",
        attacked_steam_id: "76561198021949067",
        duration: 2.35,
        team_flash: false,
      },
      {
        round: 2,
        tick: 5101,
        attacker_steam_id: "76561198094364763",
        attacked_steam_id: "76561198094364764",
        duration: 0.8,
        team_flash: true,
      },
    ]);
  });

  // The parser builds the blob when asked, and the api stores it as it came.
  describe("a blob the parser built", () => {
    const gz = zlib.gzipSync(Buffer.from('{"match_map_id":"map"}'));
    const built = (matchMapId: string): ParsedDemo => ({
      total_ticks: 100,
      tick_rate: 64,
      round_ticks: [],
      kills: [],
      bombs: [],
      playback: {
        schema_version: DEMO_METADATA_VERSION,
        match_map_id: matchMapId,
        blob: gz.toString("base64"),
        positions: 3,
        shots_fired: 2,
        grenade_events: 1,
        smoke_volumes: 0,
        smoke_voxels: 0,
        infernos: 0,
        damages: 0,
        flashes: 0,
      },
    });
    const mocks = () => ({
      put: jest.fn<Promise<void>, [string, Buffer]>(async () => {}),
      query: jest.fn<Promise<Array<unknown>>, [string, Array<unknown>]>(
        async () => [],
      ),
    });
    const service = ({ put, query }: ReturnType<typeof mocks>) =>
      new DemoMetadataService(
        new Logger("DemoMetadataTest"),
        null as never,
        { query } as never,
        { put } as never,
        null as never,
        null as never,
        null as never,
      );

    it("is uploaded byte for byte", async () => {
      const m = mocks();
      await service(m).uploadPlaybackBlob("match", "map", "demo", built("map"));

      expect(Buffer.compare(m.put.mock.calls[0][1], gz)).toBe(0);
      expect(m.query.mock.calls[0][1]).toEqual(
        expect.arrayContaining([gz.byteLength, DEMO_METADATA_VERSION]),
      );
    });

    // The parse leaves the blob's fields out once the parser built one, so a
    // blob for the wrong map cannot be rebuilt here; storing it would be worse.
    it("is refused when it was built for another match map", async () => {
      const m = mocks();
      await expect(
        service(m).uploadPlaybackBlob(
          "match",
          "map",
          "demo",
          built("other-map"),
        ),
      ).rejects.toThrow(/other-map/);
      expect(m.put).not.toHaveBeenCalled();
    });
  });

  // A parser older than these fields still produces a well-formed blob.
  it("defaults the new arrays to empty for an older parser", async () => {
    const { blob } = await upload({
      total_ticks: 100,
      tick_rate: 64,
      round_ticks: [],
      kills: [],
      bombs: [],
    });

    expect(blob.smoke_voxels).toEqual([]);
    expect(blob.flashes).toEqual([]);
    expect(blob.damages).toEqual([]);
    expect(blob.parser_schema_version).toBeNull();
  });
});

describe("DemoMetadataService.ensureParsedById", () => {
  const ROW: DemoRow = {
    id: "demo-1",
    match_id: "match-1",
    match_map_id: "map-1",
    file: "demos/match-1/map-1/1-de_inferno.dem",
    playback_file: null,
    total_ticks: null,
    tick_rate: null,
    round_ticks: null,
    workshop_id: null,
    cs2_build: null,
    metadata_parsed_at: null,
  };

  function make(row: Record<string, unknown>, parse: jest.Mock) {
    return new DemoMetadataService(
      new Logger("DemoMetadataTest"),
      {
        query: jest.fn(async () => ({ match_map_demos_by_pk: row })),
      } as never,
      { query: jest.fn(async (): Promise<unknown[]> => []) } as never,
      { put: jest.fn(async () => {}) } as never,
      { parseFromS3Key: parse } as never,
      null as never,
      null as never,
    );
  }

  const parsed: Pick<ParsedDemo, "total_ticks" | "tick_rate" | "round_ticks"> =
    { total_ticks: 100, tick_rate: 64, round_ticks: [] };

  // The upload path reads this to know the stats have just been written.
  it("answers true when this call parsed the demo", async () => {
    const parse = jest.fn(async () => parsed);

    await expect(make(ROW, parse).ensureParsedById("demo-1")).resolves.toBe(
      true,
    );
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("answers false for a demo that is already parsed", async () => {
    const parse = jest.fn(async () => parsed);
    const fresh = {
      ...ROW,
      total_ticks: 100,
      metadata_parsed_at: "2026-10-12T00:00:00Z",
      playback_file: `demos/match-1/map-1/playback/playback.v${DEMO_METADATA_VERSION}.1.json.gz`,
    };

    await expect(make(fresh, parse).ensureParsedById("demo-1")).resolves.toBe(
      false,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("answers false when the parse fails", async () => {
    const parse = jest.fn(async () => {
      throw new Error("demo-parser 500");
    });

    await expect(make(ROW, parse).ensureParsedById("demo-1")).resolves.toBe(
      false,
    );
  });
});
