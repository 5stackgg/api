import zlib from "zlib";
import { Logger } from "@nestjs/common";
import {
  DEMO_METADATA_VERSION,
  DemoMetadataService,
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
