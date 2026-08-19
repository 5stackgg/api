import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { Client } from "typesense";
import { HasuraService } from "../hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { TypeSenseConfig } from "../configs/types/TypeSenseConfig";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { CollectionFieldSchema } from "typesense/lib/Typesense/Collection";
import { TypesenseQueues } from "./enums/TypesenseQueues";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PostgresService } from "../postgres/postgres.service";
import { RefreshAllPlayersJob } from "./jobs/RefreshAllPlayers";
import { RefreshAllNadeLineupsJob } from "./jobs/RefreshAllNadeLineups";

// One publicly visible lineup, as the global search bar needs it. Only ever
// produced by searchableNadeLineups, which is the one place the visibility
// filter lives.
export type SearchableNadeLineup = {
  id: string;
  name: string;
  map_name: string;
  nade_type: string;
  side: string;
  technique: string;
  tags: Array<string> | null;
  author_steam_id: string;
  author_name: string | null;
  upvotes: number;
  favorites: number;
  created_at: Date;
};

@Injectable()
export class TypeSenseService {
  private client: Client;

  // A private or team lineup in a global index is a leak, so the index is
  // rebuilt in pages of this size rather than held in memory in one go.
  public static readonly NADE_LINEUP_PAGE = 500;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    @Inject(forwardRef(() => MatchAssistantService))
    private readonly matchAssistant: MatchAssistantService,
    @InjectQueue(TypesenseQueues.PlayerReindex) private reindexQueue: Queue,
    @InjectQueue(TypesenseQueues.NadeLineupReindex)
    private nadeReindexQueue: Queue,
    private readonly postgres: PostgresService,
  ) {}

  public async setup() {
    this.client = new Client({
      nodes: [
        {
          host: "typesense",
          port: 8108,
          protocol: "http",
        },
      ],
      apiKey: this.config.get<TypeSenseConfig>("typesense").apiKey,
      connectionTimeoutSeconds: 2,
    });

    try {
      await this.createCvarsCollection();
      await this.createPlayerCollection();
      await this.createNadeLineupCollection();
    } catch (error) {
      this.logger.error(`unable to setup typesense: ${error}`);
      setTimeout(() => {
        void this.setup();
      }, 1000);
    }
  }

  public async createPlayerCollection() {
    const fields: CollectionFieldSchema[] = [
      {
        name: "name",
        type: "string",
        index: true,
        sort: true,
        infix: true,
      },
      { name: "steam_id", type: "string", index: true },
      { name: "teams", type: "string[]", optional: true },
      // Rank/range on the same number the UI shows (competitive, else wingman,
      // else duel). Sorting on elo_competitive alone leaves every wingman/duel
      // only player tied as "missing", so asc/desc never reorders them.
      {
        name: "elo",
        type: "int32",
        optional: true,
        sort: true,
        index: true,
      },
      {
        name: "tournament_elo",
        type: "int32",
        optional: true,
        sort: true,
        index: true,
      },
      {
        name: "elo_competitive",
        type: "int32",
        optional: true,
        sort: true,
        index: true,
      },
      {
        name: "elo_wingman",
        type: "int32",
        optional: true,
        sort: true,
        index: true,
      },
      {
        name: "elo_duel",
        type: "int32",
        optional: true,
        sort: true,
        index: true,
      },
      {
        name: "tournament_elo_competitive",
        type: "int32",
        optional: true,
        sort: true,
        index: true,
      },
      {
        name: "tournament_elo_wingman",
        type: "int32",
        optional: true,
        sort: true,
        index: true,
      },
      {
        name: "tournament_elo_duel",
        type: "int32",
        optional: true,
        sort: true,
        index: true,
      },
      { name: "role", type: "string", optional: true, index: true },
      { name: "kills", type: "int32", optional: true },
      { name: "deaths", type: "int32", optional: true },
      { name: "wins", type: "int32", optional: true },
      { name: "losses", type: "int32", optional: true },
      { name: "total_matches", type: "int32", optional: true, index: true },
      { name: "country", type: "string", optional: true, index: true },
      { name: "sanctions", type: "int32", optional: true, index: true },
      { name: "is_banned", type: "bool", optional: true, index: true },
      { name: "is_gagged", type: "bool", optional: true, index: true },
      { name: "is_muted", type: "bool", optional: true, index: true },
      {
        name: "last_sign_in_at",
        type: "string",
        symbols_to_index: ["~"],
        optional: true,
        sort: true,
        index: true,
      },
      // Has the player ever signed in here, as opposed to a Steam account we
      // only know about (e.g. picked up from someone else's friend list).
      // Informational — every player stays searchable either way.
      { name: "is_registered", type: "bool", optional: true, index: true },
      { name: "avatar_url", type: "string", optional: true, index: false },
      {
        name: "custom_avatar_url",
        type: "string",
        optional: true,
        index: false,
      },
      {
        name: "roster_image_url",
        type: "string",
        optional: true,
        index: false,
      },
      { name: "profile_url", type: "string", optional: true, index: false },
    ];

    const exists = await this.client.collections("players").exists();

    if (!exists) {
      await this.client.collections().create({
        name: "players",
        fields,
        default_sorting_field: "name",
      } as any);
      await this.reindexQueue.add(
        RefreshAllPlayersJob.name,
        {},
        {
          jobId: RefreshAllPlayersJob.name,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );

      return;
    }

    const collection = await this.client.collections("players").retrieve();

    const fieldUpdates: Array<Record<string, unknown>> = [];
    let needsRefresh = false;

    for (const field of fields) {
      const existing = collection.fields.find((f) => f.name === field.name);

      if (!existing) {
        fieldUpdates.push(field);
        needsRefresh = true;
        continue;
      }

      // Typesense returns fields fully populated with its defaults, so compare
      // against those defaults (not the raw literal) to avoid a perpetual diff
      // that would drop/re-add fields and trigger a full reindex on every boot.
      const sortChanged =
        Boolean(existing.sort) !== this.expectedSort(field);
      const indexChanged =
        Boolean(existing.index) !== this.expectedIndex(field);
      const typeChanged = existing.type !== field.type;

      if (sortChanged || indexChanged || typeChanged) {
        fieldUpdates.push({ name: field.name, drop: true });
        fieldUpdates.push(field);
        needsRefresh = true;
      }
    }

    if (fieldUpdates.length > 0) {
      await this.client.collections("players").update({
        fields: fieldUpdates as CollectionFieldSchema[],
      });

      if (needsRefresh) {
        await this.reindexQueue.add(
          RefreshAllPlayersJob.name,
          {},
          {
            jobId: RefreshAllPlayersJob.name,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      }
    }
  }

  // Typesense: `index` defaults to true; `sort` defaults to true for numeric
  // and bool fields (only when indexed) and false for everything else.
  private static readonly SORTABLE_BY_DEFAULT = new Set([
    "int32",
    "int64",
    "float",
    "bool",
  ]);

  private expectedIndex(field: CollectionFieldSchema): boolean {
    return field.index ?? true;
  }

  private expectedSort(field: CollectionFieldSchema): boolean {
    if (field.sort !== undefined) {
      return field.sort;
    }
    return (
      this.expectedIndex(field) &&
      TypeSenseService.SORTABLE_BY_DEFAULT.has(field.type)
    );
  }

  public async createNadeLineupCollection() {
    if (await this.client.collections("nade_lineups").exists()) {
      return;
    }

    await this.client.collections().create({
      name: "nade_lineups",
      fields: [
        {
          name: "name",
          type: "string",
          index: true,
          sort: true,
          infix: true,
        },
        { name: "map_name", type: "string", index: true },
        { name: "nade_type", type: "string", index: true },
        { name: "side", type: "string", index: true },
        { name: "technique", type: "string", index: true },
        { name: "tags", type: "string[]", optional: true, index: true },
        { name: "author", type: "string", optional: true, index: true },
        { name: "author_steam_id", type: "string", index: true },
        { name: "upvotes", type: "int32", index: true, sort: true },
        { name: "favorites", type: "int32", index: true, sort: true },
        { name: "created_at", type: "int64", index: true, sort: true },
      ],
      default_sorting_field: "name",
    } as never);

    await this.nadeReindexQueue.add(
      RefreshAllNadeLineupsJob.name,
      {},
      {
        jobId: RefreshAllNadeLineupsJob.name,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  // THE visibility filter for the global index. Everything that writes a nade
  // document goes through here, so "only what is publicly visible is indexed"
  // is one predicate rather than a rule every call site has to remember. A
  // lineup that stops qualifying returns nothing, which is what makes
  // updateNadeLineup delete rather than upsert.
  public async searchableNadeLineups(
    options: {
      ids?: Array<string> | null;
      after?: string | null;
      limit?: number;
    } = {},
  ): Promise<Array<SearchableNadeLineup>> {
    return await this.postgres.query<Array<SearchableNadeLineup>>(
      `SELECT l.id::text AS id, l.name, l.map_name, l.nade_type, l.side,
              l.technique, l.tags,
              l.author_steam_id::text AS author_steam_id,
              p.name AS author_name,
              l.upvotes, l.favorites, l.created_at
         FROM public.nade_lineups l
         LEFT JOIN public.players p ON p.steam_id = l.author_steam_id
        WHERE l.visibility = 'Public'
          AND l.archived_at IS NULL
          AND ($1::uuid[] IS NULL OR l.id = ANY($1::uuid[]))
          AND ($2::uuid IS NULL OR l.id > $2::uuid)
        ORDER BY l.id ASC
        LIMIT $3::int`,
      [
        options.ids ?? null,
        options.after ?? null,
        options.limit ?? TypeSenseService.NADE_LINEUP_PAGE,
      ],
    );
  }

  // One row's worth of index maintenance. A lineup that has gone private, been
  // archived or been deleted is removed rather than left behind: the row is
  // gone from the library either way, and a stale document is the leak.
  public async updateNadeLineup(lineupId: string) {
    const [lineup] = await this.searchableNadeLineups({ ids: [lineupId] });

    if (!lineup) {
      await this.removeNadeLineup(lineupId);
      return;
    }

    await this.client
      .collections("nade_lineups")
      .documents()
      .upsert(TypeSenseService.nadeLineupDocument(lineup));
  }

  public async removeNadeLineup(lineupId: string) {
    try {
      await this.client
        .collections("nade_lineups")
        .documents(lineupId)
        .delete();
    } catch {
      // Deleting a document that was never indexed is the normal case: every
      // edit to a private lineup lands here.
    }
  }

  public async reindexNadeLineups(): Promise<number> {
    let after: string | null = null;
    let indexed = 0;

    for (;;) {
      const page: Array<SearchableNadeLineup> =
        await this.searchableNadeLineups({ after });

      if (page.length === 0) {
        break;
      }

      await this.client
        .collections("nade_lineups")
        .documents()
        .import(page.map(TypeSenseService.nadeLineupDocument), {
          action: "upsert",
        });

      after = page.at(-1)!.id;
      indexed += page.length;
    }

    this.logger.log(`indexed ${indexed} public nade lineup(s)`);

    return indexed;
  }

  public static nadeLineupDocument(lineup: SearchableNadeLineup) {
    return {
      id: lineup.id,
      name: lineup.name,
      map_name: lineup.map_name,
      nade_type: lineup.nade_type,
      side: lineup.side,
      technique: lineup.technique,
      tags: lineup.tags ?? [],
      author: lineup.author_name ?? "",
      author_steam_id: lineup.author_steam_id,
      upvotes: Number(lineup.upvotes) || 0,
      favorites: Number(lineup.favorites) || 0,
      created_at: Math.floor(new Date(lineup.created_at).getTime() / 1000),
    };
  }

  public async createCvarsCollection() {
    if (!(await this.client.collections("cvars").exists())) {
      await this.client.collections().create({
        name: "cvars",
        fields: [
          {
            name: "name",
            type: "string",
            index: true,
            sort: true,
            infix: true,
          },
          { name: "kind", type: "string" },
          { name: "flags", type: "string" },
          { name: "description", type: "string", index: true, infix: true },
        ],
      });
    }
  }

  public async upsertCvars(
    cvars: Array<{
      name: string;
      kind: string;
      flags: string;
      description: string;
    }>,
  ) {
    if (cvars.length === 0) {
      return;
    }

    try {
      const cvarsWithIds = cvars.map((cvar) => ({
        id: cvar.name,
        ...cvar,
      }));

      return await this.client
        .collections("cvars")
        .documents()
        .import(cvarsWithIds, { action: "upsert" });
    } catch (error) {
      this.logger.error(`unable to upsert cvars: ${error}`);
      throw error;
    }
  }

  public async resetCvars() {
    try {
      await this.client.collections("cvars").delete();
    } catch (error) {
      this.logger.error(`unable to delete cvars collection: ${error}`);
    }

    await this.createCvarsCollection();
  }

  public async updatePlayer(steamId: string) {
    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        elo: true,
        name: true,
        role: true,
        country: true,
        avatar_url: true,
        custom_avatar_url: true,
        roster_image_url: true,
        profile_url: true,
        is_banned: true,
        is_gagged: true,
        is_muted: true,
        teams: {
          id: true,
        },
        last_sign_in_at: true,
        wins: true,
        losses: true,
        total_matches: true,
        stats: {
          kills: true,
          deaths: true,
        },
        sanctions_aggregate: {
          aggregate: {
            count: true,
          },
        },
      },
    });

    if (!player) {
      throw Error("unable to find player");
    }

    const { match_lineup_players } = await this.hasura.query({
      match_lineup_players: {
        __args: {
          where: {
            steam_id: {
              _eq: steamId,
            },
            lineup: {
              match: {
                status: {
                  _eq: "Live",
                },
              },
            },
          },
        },
        lineup: {
          match: {
            id: true,
          },
        },
      },
    });

    if (player.is_banned || player.is_gagged || player.is_muted) {
      for (const matchLineupPlayer of match_lineup_players) {
        await this.matchAssistant.sendServerMatchId(
          matchLineupPlayer.lineup.match.id,
        );
      }
    }

    const isRegistered = !!player.last_sign_in_at;

    // this is to allow filtering
    player.last_sign_in_at = player.last_sign_in_at || "~~";

    const elo = {
      elo_competitive: player.elo["competitive"]
        ? parseInt(String(player.elo["competitive"]), 10)
        : null,
      elo_wingman: player.elo["wingman"]
        ? parseInt(String(player.elo["wingman"]), 10)
        : null,
      elo_duel: player.elo["duel"]
        ? parseInt(String(player.elo["duel"]), 10)
        : null,
      tournament_elo_competitive: player.elo["tournament_competitive"]
        ? parseInt(String(player.elo["tournament_competitive"]), 10)
        : null,
      tournament_elo_wingman: player.elo["tournament_wingman"]
        ? parseInt(String(player.elo["tournament_wingman"]), 10)
        : null,
      tournament_elo_duel: player.elo["tournament_duel"]
        ? parseInt(String(player.elo["tournament_duel"]), 10)
        : null,
    };

    delete player.elo;

    return await this.client
      .collections("players")
      .documents()
      .upsert(
        Object.assign({}, player, elo, {
          id: steamId,
          steam_id: steamId,
          is_registered: isRegistered,
          elo: TypeSenseService.primaryElo(
            elo.elo_competitive,
            elo.elo_wingman,
            elo.elo_duel,
          ),
          tournament_elo: TypeSenseService.primaryElo(
            elo.tournament_elo_competitive,
            elo.tournament_elo_wingman,
            elo.tournament_elo_duel,
          ),
          total_matches: player.total_matches
            ? parseInt(String(player.total_matches), 10)
            : 0,
          kills: player.stats?.kills
            ? parseInt(String(player.stats.kills), 10)
            : 0,
          deaths: player.stats?.deaths
            ? parseInt(String(player.stats.deaths), 10)
            : 0,
          wins: player.wins ? parseInt(String(player.wins), 10) : 0,
          losses: player.losses ? parseInt(String(player.losses), 10) : 0,
          teams: player.teams?.map(({ id }) => {
            return id;
          }),
          sanctions: player.sanctions_aggregate?.aggregate?.count || 0,
          is_banned: player.is_banned,
          is_gagged: player.is_gagged,
          is_muted: player.is_muted,
        }),
      );
  }

  // Mirrors PlayerElo's display order so the sorted value is the one on screen.
  private static primaryElo(...values: Array<number | null>): number | null {
    return values.find((value) => value !== null) ?? null;
  }

  public async removePlayer(steamId: string) {
    await this.client.collections("players").documents(steamId).delete();
  }
}
