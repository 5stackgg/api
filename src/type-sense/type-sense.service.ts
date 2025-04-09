import { Injectable } from "@nestjs/common";
import { Client } from "typesense";
import { HasuraService } from "../hasura/hasura.service";
import { ConfigService } from "@nestjs/config";
import { TypeSenseConfig } from "../configs/types/TypeSenseConfig";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";

@Injectable()
export class TypeSenseService {
  private client: Client;

  constructor(
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly matchAssistant: MatchAssistantService,
  ) {
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
  }

  public async setup() {
    await this.createPlayerCollection();
  }

  public async createPlayerCollection() {
    if (!(await this.client.collections("players").exists())) {
      await this.client.collections().create({
        name: "players",
        fields: [
          {
            name: "name",
            type: "string",
            index: true,
            sort: true,
            infix: true,
          },
          { name: "steam_id", type: "string", index: true },
          { name: "avatar_url", type: "string", optional: true },
          { name: "teams", type: "string[]", optional: true },
          { name: "elo", type: "int32", optional: true },
        ],
        default_sorting_field: "name",
      });
    }
  }

  public async updatePlayer(steamId: string) {
    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        elo: true,
        name: true,
        country: true,
        avatar_url: true,
        is_banned: true,
        is_gagged: true,
        is_muted: true,
        teams: {
          id: true,
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

    for (const matchLineupPlayer of match_lineup_players) {
      await this.matchAssistant.sendServerMatchId(
        matchLineupPlayer.lineup.v_match_lineup.match_id,
      );
    }

    return await this.client
      .collections("players")
      .documents()
      .upsert(
        Object.assign({}, player, {
          id: steamId,
          steam_id: steamId,
          teams: player.teams?.map(({ id }) => {
            return id;
          }),
        }),
      );
  }

  public async removePlayer(steamId: string) {
    await this.client.collections("players").documents(steamId).delete();
  }
}
