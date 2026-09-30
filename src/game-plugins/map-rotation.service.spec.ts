import { MapRotationService } from "./map-rotation.service";

const mapChooser = {
  files: {
    "addons/{runtime}/configs/plugins/MapChooser/maps.jsonc": {
      MapChooserMaps: { Maps: "{{maps}}" },
    },
    "addons/{runtime}/configs/plugins/MapChooser/config.jsonc": {
      MapChooser: { Cycle: { Enabled: true, RandomOrder: "{{shuffle}}" } },
    },
  },
  map: { Name: "{{label}}", Id: "{{id}}" },
};

const rotation = {
  maps: [
    { name: "de_dust2", label: null, workshop_map_id: null },
    {
      name: "3615968422",
      label: "Prophunt Mirage",
      workshop_map_id: "3615968422",
    },
  ],
  shuffle: true,
};

describe("MapRotationService", () => {
  describe("render", () => {
    it("writes each file with the runtime substituted into its path", () => {
      const files = MapRotationService.render(
        mapChooser,
        rotation,
        "swiftlys2",
      );

      expect(Object.keys(files).sort()).toEqual([
        "addons/swiftlys2/configs/plugins/MapChooser/config.jsonc",
        "addons/swiftlys2/configs/plugins/MapChooser/maps.jsonc",
      ]);
    });

    it("renders the map list as an array, using the workshop id where there is one", () => {
      const files = MapRotationService.render(
        mapChooser,
        rotation,
        "swiftlys2",
      );

      expect(
        JSON.parse(
          files["addons/swiftlys2/configs/plugins/MapChooser/maps.jsonc"],
        ),
      ).toEqual({
        MapChooserMaps: {
          Maps: [
            { Name: "de_dust2", Id: "de_dust2" },
            { Name: "Prophunt Mirage", Id: "3615968422" },
          ],
        },
      });
    });

    // MapChooser changes map by display name, so a shared name would make the
    // second map unplayable.
    it("gives maps that share a display name distinct names", () => {
      const files = MapRotationService.render(
        mapChooser,
        {
          maps: [
            { name: "1111", label: "aim_map", workshop_map_id: "1111" },
            { name: "2222", label: "AIM_MAP", workshop_map_id: "2222" },
            { name: "de_dust2", label: null, workshop_map_id: null },
          ],
          shuffle: true,
        },
        "swiftlys2",
      );

      expect(
        JSON.parse(
          files["addons/swiftlys2/configs/plugins/MapChooser/maps.jsonc"],
        ).MapChooserMaps.Maps.map((map: { Name: string }) => map.Name),
      ).toEqual(["aim_map (1111)", "AIM_MAP (2222)", "de_dust2"]);
    });

    it("keeps shuffle a boolean", () => {
      const files = MapRotationService.render(
        mapChooser,
        { ...rotation, shuffle: false },
        "swiftlys2",
      );

      expect(
        JSON.parse(
          files["addons/swiftlys2/configs/plugins/MapChooser/config.jsonc"],
        ).MapChooser.Cycle,
      ).toEqual({ Enabled: true, RandomOrder: false });
    });

    it("interpolates tokens inside longer strings and leaves unknown ones alone", () => {
      const files = MapRotationService.render(
        {
          files: { "maps.txt.json": { lines: "{{maps}}" } },
          map: { line: "ws:{{workshop_id}} {{name}} {{nope}}" },
        },
        rotation,
        "counterstrikesharp",
      );

      expect(JSON.parse(files["maps.txt.json"]).lines).toEqual([
        { line: "ws: de_dust2 {{nope}}" },
        { line: "ws:3615968422 3615968422 {{nope}}" },
      ]);
    });
  });

  describe("startMap", () => {
    it("starts on the first map when the rotation plays in order", () => {
      expect(
        MapRotationService.startMap(
          { ...rotation, shuffle: false },
          () => 0.99,
        ),
      ).toEqual(rotation.maps[0]);
    });

    it("starts on a random map when shuffled", () => {
      expect(MapRotationService.startMap(rotation, () => 0.99)).toEqual(
        rotation.maps[1],
      );
      expect(MapRotationService.startMap(rotation, () => 0)).toEqual(
        rotation.maps[0],
      );
    });

    it("has nothing to start on without a rotation", () => {
      expect(
        MapRotationService.startMap({ maps: [], shuffle: true }),
      ).toBeNull();
    });
  });
});
