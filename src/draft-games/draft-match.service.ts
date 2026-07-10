import { Logger } from "@nestjs/common";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { e_map_pool_types_enum } from "generated";
import { HasuraService } from "src/hasura/hasura.service";
import { CacheService } from "src/cache/cache.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { ChatService } from "src/chat/chat.service";
import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import { DraftGameService } from "./draft-game.service";
import { DraftGame } from "./types/DraftGame";

@Injectable()
export class DraftMatchService {
  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly cache: CacheService,
    public readonly matchAssistant: MatchAssistantService,
    private readonly chat: ChatService,
    @Inject(forwardRef(() => DraftGameService))
    private readonly draftGameService: DraftGameService,
  ) {}

  public async finalize(draftGameId: string) {
    const draftGame = await this.draftGameService.getDraftGame(draftGameId);

    if (!draftGame || draftGame.status === "Completed") {
      return;
    }

    let match = await this.findExistingMatch(draftGame);

    if (!match) {
      await this.hasura.mutation({
        update_draft_games_by_pk: {
          __args: {
            pk_columns: { id: draftGameId },
            _set: { status: "CreatingMatch" },
          },
          __typename: true,
        },
      });

      const beforeCreate =
        await this.draftGameService.getDraftGame(draftGameId);
      if (
        !beforeCreate ||
        beforeCreate.status === "Canceled" ||
        beforeCreate.status === "Completed"
      ) {
        return;
      }

      match = await this.findExistingMatch(beforeCreate);

      if (!match) {
        try {
          match = await this.createMatch(beforeCreate);
        } catch (error) {
          // A draft left in CreatingMatch is stuck forever: the expiry job
          // only cleans Open rows and its players stay locked out of every
          // other lobby. Cancel it so everyone is released.
          this.logger.error(
            `unable to create match for draft game ${draftGameId}, canceling the draft`,
            error,
          );

          await this.hasura.mutation({
            update_draft_games_by_pk: {
              __args: {
                pk_columns: { id: draftGameId },
                _set: { status: "Canceled" },
              },
              __typename: true,
            },
          });

          return;
        }

        await this.hasura.mutation({
          update_draft_games_by_pk: {
            __args: {
              pk_columns: { id: draftGameId },
              _set: { match_id: match.id },
            },
            __typename: true,
          },
        });
      }
    }

    await this.ensureLineups(draftGame, match);

    // The room's conversation continues in the match chat: carry the history
    // over and tear down the draft lobby so non-participants drop out.
    await this.chat.migrateLobbyMessages(
      ChatLobbyType.Draft,
      draftGameId,
      ChatLobbyType.Match,
      match.id,
    );

    const beforeComplete =
      await this.draftGameService.getDraftGame(draftGameId);
    if (!beforeComplete || beforeComplete.status === "Canceled") {
      return;
    }

    await this.hasura.mutation({
      update_draft_games_by_pk: {
        __args: {
          pk_columns: { id: draftGameId },
          _set: {
            status: "Completed",
            match_id: match.id,
            match_options_id: null,
          },
        },
        __typename: true,
      },
    });

    await this.matchAssistant.updateMatchStatus(match.id, "WaitingForCheckIn");
  }

  private async ensureLineups(
    draftGame: DraftGame,
    match: { lineup_1_id?: string | null; lineup_2_id?: string | null },
  ) {
    const lineupIds = [match.lineup_1_id, match.lineup_2_id].filter(
      (id): id is string => !!id,
    );

    if (lineupIds.length === 0) {
      return;
    }

    const { match_lineup_players } = await this.hasura.query({
      match_lineup_players: {
        __args: {
          where: { match_lineup_id: { _in: lineupIds } },
          limit: 1,
        },
        steam_id: true,
      },
    });

    if (match_lineup_players.length > 0) {
      return;
    }

    const { team1, team2 } = this.buildTeams(draftGame);
    const captain1 = this.captainSteamId(team1);
    const captain2 = this.captainSteamId(team2);

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: team1.map((player) => ({
            steam_id: player.steam_id,
            match_lineup_id: match.lineup_1_id,
            captain: player.steam_id === captain1,
          })),
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: team2.map((player) => ({
            steam_id: player.steam_id,
            match_lineup_id: match.lineup_2_id,
            captain: player.steam_id === captain2,
          })),
        },
        __typename: true,
      },
    });
  }

  private buildTeams(draftGame: DraftGame) {
    return {
      team1: draftGame.players.filter((player) => player.lineup === 1),
      team2: draftGame.players.filter((player) => player.lineup === 2),
    };
  }

  private async findExistingMatch(draftGame: DraftGame): Promise<{
    id: string;
    lineup_1_id?: string | null;
    lineup_2_id?: string | null;
  } | null> {
    if (draftGame.match_id) {
      const { matches_by_pk } = await this.hasura.query({
        matches_by_pk: {
          __args: { id: draftGame.match_id },
          id: true,
          lineup_1_id: true,
          lineup_2_id: true,
        },
      });

      if (matches_by_pk) {
        return matches_by_pk;
      }
    }

    if (draftGame.match_options_id) {
      const { matches } = await this.hasura.query({
        matches: {
          __args: {
            where: { match_options_id: { _eq: draftGame.match_options_id } },
            limit: 1,
          },
          id: true,
          lineup_1_id: true,
          lineup_2_id: true,
        },
      });

      if (matches.length > 0) {
        return matches[0];
      }
    }

    return null;
  }

  private async createMatch(draftGame: DraftGame) {
    if (draftGame.match_options_id) {
      const { insert_matches_one } = await this.hasura.mutation({
        insert_matches_one: {
          __args: {
            object: {
              match_options_id: draftGame.match_options_id,
              organizer_steam_id: draftGame.host_steam_id,
              ...(draftGame.mode === "Teams"
                ? {
                    lineup_1: { data: { team_id: draftGame.team_1_id } },
                    lineup_2: { data: { team_id: draftGame.team_2_id } },
                  }
                : {}),
            },
          },
          id: true,
          lineup_1_id: true,
          lineup_2_id: true,
        },
      });

      return insert_matches_one;
    }

    const mapPoolType: e_map_pool_types_enum =
      draftGame.type === "Premier" || draftGame.type === "Faceit"
        ? "Competitive"
        : draftGame.type;

    const maps = await this.getMapPoolMaps(draftGame.map_pool_id);

    const match = await this.matchAssistant.createMatchBasedOnType(
      draftGame.type,
      mapPoolType,
      {
        mr: draftGame.type === "Competitive" ? 12 : 8,
        best_of: 1,
        knife: true,
        overtime: true,
        timeout_setting: "Admin",
        ...(maps.length > 0 && { maps }),
      },
    );

    await this.setMatchOptionsRegions(match.id, draftGame.regions);

    return match;
  }

  private captainSteamId(
    team: Array<{ steam_id: string; pick_order?: number }>,
  ) {
    return [...team].sort(
      (a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0),
    )[0]?.steam_id;
  }

  private async getMapPoolMaps(mapPoolId?: string): Promise<Array<string>> {
    if (!mapPoolId) {
      return [];
    }

    const { _map_pool } = await this.hasura.query({
      _map_pool: {
        __args: {
          where: {
            map_pool_id: { _eq: mapPoolId },
          },
        },
        map_id: true,
      },
    });

    return _map_pool.map((row) => row.map_id);
  }

  private async setMatchOptionsRegions(
    matchId: string,
    regions: Array<string>,
  ) {
    if (!regions || regions.length === 0) {
      return;
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        match_options_id: true,
      },
    });

    if (!match?.match_options_id) {
      return;
    }

    await this.hasura.mutation({
      update_match_options_by_pk: {
        __args: {
          pk_columns: { id: match.match_options_id },
          _set: { regions },
        },
        __typename: true,
      },
    });
  }
}
