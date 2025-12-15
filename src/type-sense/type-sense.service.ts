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
import { RefreshAllPlayersJob } from "./jobs/RefreshAllPlayers";

@Injectable()
export class TypeSenseService {
  private client: Client;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    @Inject(forwardRef(() => MatchAssistantService))
    private readonly matchAssistant: MatchAssistantService,
    @InjectQueue(TypesenseQueues.TypeSense) private queue: Queue,
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

    let setup = false;
    while (!setup) {
      try {
        await this.createCvarsCollection();
        await this.createPlayerCollection();
        setup = true;
      } catch (error) {
        this.logger.error(`unable to setup typesense: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
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
      { name: "elo", type: "int32", optional: true, index: true },
      { name: "role", type: "string", optional: true, index: true },
      { name: "kills", type: "int32", optional: true },
      { name: "deaths", type: "int32", optional: true },
      { name: "wins", type: "int32", optional: true },
      { name: "losses", type: "int32", optional: true },
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
      },
    ];

    const exists = await this.client.collections("players").exists();

    if (!exists) {
      await this.client.collections().create({
        name: "players",
        fields,
        default_sorting_field: "name",
      } as any);
      await this.queue.add(RefreshAllPlayersJob.name, {});

      return;
    }

    const collection = await this.client.collections("players").retrieve();

    const missingFields = fields.filter((field) => {
      return !collection.fields.find((_existingField) => {
        return _existingField.name === field.name;
      });
    });

    if (missingFields.length > 0) {
      await this.client.collections("players").update({
        fields: missingFields,
      });

      await this.queue.add(RefreshAllPlayersJob.name, {});
    }
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
        is_banned: true,
        is_gagged: true,
        is_muted: true,
        teams: {
          id: true,
        },
        last_sign_in_at: true,
        wins: true,
        losses: true,
        kills_aggregate: {
          aggregate: {
            count: true,
          },
        },
        deaths_aggregate: {
          aggregate: {
            count: true,
          },
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
              v_match_lineup: {
                match: {
                  status: {
                    _eq: "Live",
                  },
                },
              },
            },
          },
        },
        lineup: {
          v_match_lineup: {
            match_id: true,
          },
        },
      },
    });

    if (player.is_banned || player.is_gagged || player.is_muted) {
      for (const matchLineupPlayer of match_lineup_players) {
        await this.matchAssistant.sendServerMatchId(
          matchLineupPlayer.lineup.v_match_lineup.match_id,
        );
      }
    }

    // this is to allow filtering
    player.last_sign_in_at = player.last_sign_in_at || "~~";

    return await this.client
      .collections("players")
      .documents()
      .upsert(
        Object.assign({}, player, {
          id: steamId,
          steam_id: steamId,
          elo: player.elo ? parseInt(String(player.elo), 10) : 0,
          kills: player.kills_aggregate?.aggregate?.count
            ? parseInt(String(player.kills_aggregate?.aggregate?.count), 10)
            : 0,
          deaths: player.deaths_aggregate?.aggregate?.count
            ? parseInt(String(player.deaths_aggregate?.aggregate?.count), 10)
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

  public async removePlayer(steamId: string) {
    await this.client.collections("players").documents(steamId).delete();
  }
}
