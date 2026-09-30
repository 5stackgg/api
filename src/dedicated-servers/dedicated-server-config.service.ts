import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { DedicatedServersService } from "./dedicated-servers.service";

type CommunityServer = {
  id: string;
  enabled: boolean;
  game: string;
};

type WorkshopItem = {
  publishedfileid: string;
  result: number;
  consumer_app_id?: number;
  banned?: number | boolean;
  title?: string;
  preview_url?: string;
};

export type ImportedWorkshopMap = {
  id: string;
  name: string;
  label: string | null;
  poster: string | null;
  workshop_map_id: string;
};

const STEAM_API = "https://api.steampowered.com/ISteamRemoteStorage";

@Injectable()
export class DedicatedServerConfigService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly dedicatedServers: DedicatedServersService,
  ) {}

  public async setMapRotation(
    serverId: string,
    mapIds: Array<string>,
    shuffle: boolean,
  ): Promise<void> {
    const server = await this.communityServer(serverId);

    if (server.game !== "cs2") {
      throw new BadRequestException("Map rotations are CS2 only");
    }

    const ids = [...new Set(mapIds)];

    await this.postgres.transaction(async (client) => {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM maps
          WHERE id = ANY($1::uuid[])
            AND deleted_at IS NULL`,
        [ids],
      );

      if (rows[0].count !== ids.length) {
        throw new BadRequestException(
          "The rotation names a map that does not exist or was deleted",
        );
      }

      await client.query(
        `DELETE FROM server_map_rotation WHERE server_id = $1`,
        [serverId],
      );

      await client.query(
        `INSERT INTO server_map_rotation (server_id, map_id, position)
         SELECT $1, rotation.map_id, rotation.position - 1
           FROM unnest($2::uuid[]) WITH ORDINALITY AS rotation(map_id, position)`,
        [serverId, ids],
      );

      await client.query(
        `UPDATE servers SET map_rotation_shuffle = $2 WHERE id = $1`,
        [serverId, shuffle],
      );
    });

    await this.restart(server);
  }

  public async setPlugins(
    serverId: string,
    plugins: Array<{ slug: string; enabled: boolean }>,
  ): Promise<void> {
    const server = await this.communityServer(serverId);

    const overrides = new Map(
      plugins.map((plugin) => [plugin.slug, plugin.enabled]),
    );

    await this.postgres.transaction(async (client) => {
      await client.query(`DELETE FROM server_plugins WHERE server_id = $1`, [
        serverId,
      ]);

      await client.query(
        `INSERT INTO server_plugins (server_id, plugin_slug, enabled)
         SELECT $1, override.slug, override.enabled
           FROM unnest($2::text[], $3::boolean[]) AS override(slug, enabled)`,
        [serverId, [...overrides.keys()], [...overrides.values()]],
      );
    });

    await this.restart(server);
  }

  // Accepts a collection or a single map, as a link or a bare id: Steam answers
  // a collection lookup for a plain item with result 9 and no children.
  public async importWorkshopCollection(
    collection: string,
  ): Promise<{ maps: Array<ImportedWorkshopMap>; skipped: number }> {
    const collectionId = DedicatedServerConfigService.workshopId(collection);

    if (!collectionId) {
      throw new BadRequestException(
        "Paste a Steam workshop collection link or id",
      );
    }

    const children = await this.collectionChildren(collectionId);
    const itemIds = children ?? [collectionId];
    const details = await this.publishedFileDetails(itemIds);

    const maps: Array<ImportedWorkshopMap> = [];
    let skipped = 0;

    for (const itemId of itemIds) {
      const item = details.get(itemId);

      if (
        !item ||
        item.result !== 1 ||
        item.consumer_app_id !== 730 ||
        item.banned ||
        !item.title
      ) {
        skipped++;
        continue;
      }

      maps.push(
        await this.upsertWorkshopMap(itemId, item.title, item.preview_url),
      );
    }

    if (maps.length === 0) {
      throw new BadRequestException(
        "That link has no public CS2 workshop maps in it",
      );
    }

    return { maps, skipped };
  }

  public static workshopId(input: string): string | null {
    const trimmed = (input ?? "").trim();

    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }

    return trimmed.match(/[?&]id=(\d+)/)?.[1] ?? null;
  }

  private async communityServer(serverId: string): Promise<CommunityServer> {
    const [server] = await this.postgres.query<
      Array<
        CommunityServer & {
          is_dedicated: boolean;
          type: string;
          game_server_node_id: string | null;
        }
      >
    >(
      `SELECT id, enabled, game, is_dedicated, type, game_server_node_id
         FROM servers
        WHERE id = $1`,
      [serverId],
    );

    if (!server?.is_dedicated) {
      throw new BadRequestException("Not a dedicated server");
    }

    if (server.type === "Ranked" || server.type === "Practice") {
      throw new BadRequestException(
        `${server.type} servers run 5Stack's own plugin set`,
      );
    }

    // The settings are delivered in the pod spec, and an external server has
    // no pod.
    if (!server.game_server_node_id) {
      throw new BadRequestException(
        "Only servers running on a game server node can be configured here",
      );
    }

    return server;
  }

  // Mirrors the servers event: a disabled server picks the settings up when it
  // is next enabled.
  private async restart(server: CommunityServer): Promise<void> {
    if (!server.enabled) {
      return;
    }

    await this.dedicatedServers.removeDedicatedServer(server.id);

    if (!(await this.dedicatedServers.setupDedicatedServer(server.id))) {
      throw new BadRequestException(
        "Saved, but the server failed to start again; check the API logs",
      );
    }
  }

  private async collectionChildren(
    collectionId: string,
  ): Promise<Array<string> | null> {
    const data = await this.steam<{
      response?: {
        collectiondetails?: Array<{
          result: number;
          children?: Array<{
            publishedfileid: string;
            sortorder: number;
            filetype: number;
          }>;
        }>;
      };
    }>("GetCollectionDetails", {
      collectioncount: "1",
      "publishedfileids[0]": collectionId,
    });

    const collection = data.response?.collectiondetails?.[0];

    if (collection?.result !== 1 || !collection.children?.length) {
      return null;
    }

    return collection.children
      .filter((child) => child.filetype === 0)
      .sort((a, b) => a.sortorder - b.sortorder)
      .map((child) => child.publishedfileid);
  }

  private async publishedFileDetails(
    itemIds: Array<string>,
  ): Promise<Map<string, WorkshopItem>> {
    const body: Record<string, string> = {
      itemcount: itemIds.length.toString(),
    };

    itemIds.forEach((itemId, index) => {
      body[`publishedfileids[${index}]`] = itemId;
    });

    const data = await this.steam<{
      response?: { publishedfiledetails?: Array<WorkshopItem> };
    }>("GetPublishedFileDetails", body);

    return new Map(
      (data.response?.publishedfiledetails ?? []).map((item) => [
        item.publishedfileid,
        item,
      ]),
    );
  }

  private async steam<T>(
    method: string,
    body: Record<string, string>,
  ): Promise<T> {
    const response = await fetch(`${STEAM_API}/${method}/v1/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      this.logger.warn(`steam ${method} answered ${response.status}`);
      throw new BadRequestException("Steam did not answer; try again");
    }

    return (await response.json()) as T;
  }

  // A workshop map is catalogued once, under Competitive and disabled, the same
  // way the map form adds one: that keeps it out of every match map pool until
  // an admin opts it in. An existing row is reused, and restored if deleted.
  private async upsertWorkshopMap(
    workshopId: string,
    title: string,
    poster: string | undefined,
  ): Promise<ImportedWorkshopMap> {
    const [existing] = await this.postgres.query<
      Array<ImportedWorkshopMap & { deleted: boolean }>
    >(
      `SELECT id, name, label, poster, workshop_map_id,
              deleted_at IS NOT NULL AS deleted
         FROM maps
        WHERE workshop_map_id = $1
        ORDER BY deleted_at IS NULL DESC, type = 'Competitive' DESC
        LIMIT 1`,
      [workshopId],
    );

    if (existing) {
      if (existing.deleted) {
        await this.postgres.query(
          `UPDATE maps SET deleted_at = NULL WHERE workshop_map_id = $1`,
          [workshopId],
        );
      }

      return {
        id: existing.id,
        name: existing.name,
        label: existing.label,
        poster: existing.poster,
        workshop_map_id: existing.workshop_map_id,
      };
    }

    const [inserted] = await this.postgres.query<Array<ImportedWorkshopMap>>(
      `INSERT INTO maps
         (name, label, workshop_map_id, poster, type, enabled, active_pool)
       VALUES ($1, $2, $1, $3, 'Competitive', false, false)
       ON CONFLICT (name, type) DO UPDATE
         SET workshop_map_id = EXCLUDED.workshop_map_id,
             deleted_at = NULL
       RETURNING id, name, label, poster, workshop_map_id`,
      [workshopId, title, poster ?? null],
    );

    return inserted;
  }
}
