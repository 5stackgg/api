import { Logger } from "@nestjs/common";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { e_map_pool_types_enum } from "generated";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";
import { HasuraService } from "src/hasura/hasura.service";
import { CacheService } from "src/cache/cache.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { ChatService } from "src/chat/chat.service";
import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import { DraftGameService } from "./draft-game.service";
import { DraftGame, DraftGamePlayer } from "./types/DraftGame";

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
    const maxPerLineup = await this.maxPlayersPerLineup(draftGame);
    const { team1, team2 } = this.buildTeams(draftGame, maxPerLineup);
    const captains = await this.getTeamCaptains(draftGame);

    const sides: Array<{
      lineupId: string;
      players: Array<DraftGamePlayer>;
      teamCaptainSteamId?: string;
    }> = [];

    if (match.lineup_1_id && team1.length > 0) {
      sides.push({
        lineupId: match.lineup_1_id,
        players: team1,
        teamCaptainSteamId: captains.team1,
      });
    }

    if (match.lineup_2_id && team2.length > 0) {
      sides.push({
        lineupId: match.lineup_2_id,
        players: team2,
        teamCaptainSteamId: captains.team2,
      });
    }

    // Prune every lineup before filling any of them: a player the draft moved to
    // the other side is still seated here, and match_lineup_players rejects
    // anyone already present anywhere in the match.
    const pending = [];
    for (const side of sides) {
      pending.push({
        ...side,
        add: await this.pruneLineup(side.lineupId, side.players),
      });
    }

    for (const side of pending) {
      await this.fillLineup(side.lineupId, side.add);
      await this.assignCaptain(
        side.lineupId,
        side.players,
        side.teamCaptainSteamId,
      );
    }
  }

  // Creating the match with a team_id makes tai_match seed the lineup straight
  // off the team roster, which ignores the slots the host assigned in the draft
  // lobby. The draft assignment wins, so drop everyone it did not assign and
  // report back who still has to be added.
  private async pruneLineup(
    lineupId: string,
    players: Array<DraftGamePlayer>,
  ): Promise<Array<string>> {
    const { match_lineup_players } = await this.hasura.query({
      match_lineup_players: {
        __args: {
          where: { match_lineup_id: { _eq: lineupId } },
        },
        steam_id: true,
      },
    });

    const assigned = new Set(players.map((player) => String(player.steam_id)));
    const existing = new Set(
      match_lineup_players.map((player) => String(player.steam_id)),
    );

    const remove = Array.from(existing).filter(
      (steamId) => !assigned.has(steamId),
    );

    if (remove.length > 0) {
      await this.hasura.mutation({
        delete_match_lineup_players: {
          __args: {
            where: {
              match_lineup_id: { _eq: lineupId },
              steam_id: { _in: remove },
            },
          },
          __typename: true,
        },
      });
    }

    return Array.from(assigned).filter((steamId) => !existing.has(steamId));
  }

  private async fillLineup(lineupId: string, steamIds: Array<string>) {
    if (steamIds.length === 0) {
      return;
    }

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: steamIds.map((steamId) => ({
            steam_id: steamId,
            match_lineup_id: lineupId,
          })),
        },
        __typename: true,
      },
    });
  }

  private async assignCaptain(
    lineupId: string,
    players: Array<DraftGamePlayer>,
    teamCaptainSteamId?: string,
  ) {
    // The captain has to be someone who actually starts, never a backup
    // riding in a substitute slot.
    const starters = players.filter((player) => player.status !== "Waitlist");
    const eligible = starters.length > 0 ? starters : players;
    const steamIds = new Set(eligible.map((player) => String(player.steam_id)));

    const captain =
      teamCaptainSteamId && steamIds.has(teamCaptainSteamId)
        ? teamCaptainSteamId
        : this.captainSteamId(eligible);

    if (!captain) {
      return;
    }

    await this.hasura.mutation({
      update_match_lineup_players: {
        __args: {
          where: {
            match_lineup_id: { _eq: lineupId },
            steam_id: { _eq: captain },
          },
          _set: { captain: true },
        },
        __typename: true,
      },
    });
  }

  private async getTeamCaptains(draftGame: DraftGame): Promise<{
    team1?: string;
    team2?: string;
  }> {
    const teamIds = [draftGame.team_1_id, draftGame.team_2_id].filter(
      (teamId): teamId is string => !!teamId,
    );

    if (teamIds.length === 0) {
      return {};
    }

    const { teams } = await this.hasura.query({
      teams: {
        __args: {
          where: { id: { _in: teamIds } },
        },
        id: true,
        captain_steam_id: true,
      },
    });

    const captains = new Map(
      teams.map((team) => [team.id, String(team.captain_steam_id)]),
    );

    return {
      team1: draftGame.team_1_id
        ? captains.get(draftGame.team_1_id)
        : undefined,
      team2: draftGame.team_2_id
        ? captains.get(draftGame.team_2_id)
        : undefined,
    };
  }

  // A side is its starters followed by its backups: the lobby's backups ride
  // along in the match's substitute slots so a no-show can be swapped in
  // without re-inviting anyone. Anything past the lineup's capacity is dropped.
  private buildTeams(draftGame: DraftGame, maxPerLineup: number) {
    const side = (lineup: number) => {
      const players = draftGame.players.filter(
        (player) => player.lineup === lineup,
      );

      const starters = players
        .filter((player) => player.status !== "Waitlist")
        .sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));

      const backups = players
        .filter((player) => player.status === "Waitlist")
        .sort((a, b) =>
          String(a.joined_at || "").localeCompare(String(b.joined_at || "")),
        );

      return [...starters, ...backups].slice(0, maxPerLineup);
    };

    return { team1: side(1), team2: side(2) };
  }

  private async maxPlayersPerLineup(draftGame: DraftGame): Promise<number> {
    const starters = Math.floor(ExpectedPlayers[draftGame.type] / 2);

    if (!draftGame.match_options_id) {
      return starters;
    }

    const { match_options_by_pk } = await this.hasura.query({
      match_options_by_pk: {
        __args: { id: draftGame.match_options_id },
        number_of_substitutes: true,
      },
    });

    return starters + (match_options_by_pk?.number_of_substitutes ?? 0);
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

  // Backups carry no pick_order, so they have to sort last or a substitute
  // would end up captaining the lineup.
  private captainSteamId(team: Array<DraftGamePlayer>) {
    return [...team].sort(
      (a, b) =>
        (a.pick_order ?? Number.MAX_SAFE_INTEGER) -
        (b.pick_order ?? Number.MAX_SAFE_INTEGER),
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
