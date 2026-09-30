import { Injectable } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { MapRotationSpec } from "./types/Registry";

export type RotationMap = {
  name: string;
  label: string | null;
  workshop_map_id: string | null;
};

export type ServerMapRotation = {
  maps: Array<RotationMap>;
  shuffle: boolean;
};

const TOKEN = /\{\{(\w+)\}\}/g;
const WHOLE_TOKEN = /^\{\{(\w+)\}\}$/;

@Injectable()
export class MapRotationService {
  constructor(private readonly postgres: PostgresService) {}

  // Only a CS2 community server plays a rotation. Rows left behind by a server
  // that was since switched to Ranked or Practice are ignored, not deleted, so
  // switching back restores them.
  public async forServer(serverId: string): Promise<ServerMapRotation> {
    const rows = await this.postgres.query<
      Array<RotationMap & { shuffle: boolean }>
    >(
      `SELECT m.name, m.label, m.workshop_map_id,
              s.map_rotation_shuffle AS shuffle
         FROM servers s
         INNER JOIN server_map_rotation r ON r.server_id = s.id
         INNER JOIN maps m ON m.id = r.map_id
        WHERE s.id = $1
          AND s.is_dedicated = true
          AND s.game = 'cs2'
          AND s.type NOT IN ('Ranked', 'Practice')
          AND m.deleted_at IS NULL
        ORDER BY r.position ASC, m.name ASC`,
      [serverId],
    );

    const seen = new Set<string>();
    const maps: Array<RotationMap> = [];

    for (const row of rows) {
      const map: RotationMap = {
        name: row.name,
        label: row.label,
        workshop_map_id: row.workshop_map_id,
      };
      const id = MapRotationService.mapId(map);

      if (seen.has(id)) {
        continue;
      }

      seen.add(id);
      maps.push(map);
    }

    return { maps, shuffle: rows[0]?.shuffle ?? true };
  }

  // What host_workshop_map or changelevel takes.
  public static mapId(map: RotationMap): string {
    return map.workshop_map_id || map.name;
  }

  public static startMap(
    rotation: ServerMapRotation,
    random: () => number = Math.random,
  ): RotationMap | null {
    if (rotation.maps.length === 0) {
      return null;
    }

    if (!rotation.shuffle) {
      return rotation.maps[0];
    }

    return rotation.maps[Math.floor(random() * rotation.maps.length)];
  }

  public static render(
    spec: MapRotationSpec,
    rotation: ServerMapRotation,
    runtime: string,
  ): Record<string, string> {
    const labels = MapRotationService.uniqueLabels(rotation.maps);

    const maps = rotation.maps.map((map, index) =>
      MapRotationService.fill(spec.map, {
        id: MapRotationService.mapId(map),
        name: map.name,
        label: labels[index],
        workshop_id: map.workshop_map_id,
      }),
    );

    const files: Record<string, string> = {};

    for (const [path, document] of Object.entries(spec.files)) {
      files[path.replaceAll("{runtime}", runtime)] = JSON.stringify(
        MapRotationService.fill(document, {
          maps,
          shuffle: rotation.shuffle,
        }),
        null,
        2,
      );
    }

    return files;
  }

  // MapChooser finds the map to change to by its display name, so a second map
  // sharing one could never be played.
  private static uniqueLabels(maps: Array<RotationMap>): Array<string> {
    const counts = new Map<string, number>();

    for (const map of maps) {
      const label = (map.label || map.name).toLowerCase();
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    return maps.map((map) => {
      const label = map.label || map.name;

      return (counts.get(label.toLowerCase()) ?? 0) > 1
        ? `${label} (${MapRotationService.mapId(map)})`
        : label;
    });
  }

  // A string that is exactly one token takes the token's own type, so
  // "{{maps}}" becomes an array and "{{shuffle}}" a boolean rather than text.
  private static fill(
    value: unknown,
    tokens: Record<string, unknown>,
  ): unknown {
    if (typeof value === "string") {
      const whole = value.match(WHOLE_TOKEN);

      if (whole && whole[1] in tokens) {
        return tokens[whole[1]];
      }

      return value.replace(TOKEN, (match, key: string) =>
        key in tokens ? String(tokens[key] ?? "") : match,
      );
    }

    if (Array.isArray(value)) {
      return value.map((item) => MapRotationService.fill(item, tokens));
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          MapRotationService.fill(item, tokens),
        ]),
      );
    }

    return value;
  }
}
