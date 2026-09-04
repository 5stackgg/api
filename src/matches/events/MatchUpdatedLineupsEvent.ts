import { resolvePlayersPerTeam } from "src/game-plugins/resolveExpectedPlayers";
import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class MatchUpdatedLineupsEvent extends MatchEventProcessor<{
  lineups: {
    lineup_1: Array<{
      name: string;
      captain: boolean;
      steam_id: string;
    }>;
    lineup_2: Array<{
      name: string;
      captain: boolean;
      steam_id: string;
    }>;
  };
}> {
  public async process() {
    const match = await this.matchAssistant.getMatchLineups(this.matchId);

    if (!match) {
      return;
    }

    const players: Array<{
      steam_id?: string;
      captain: boolean;
      discord_id: string;
      match_lineup_id: string;
      placeholder_name?: string;
    }> = [];

    for (const lineup in this.data.lineups) {
      for (const player of this.data.lineups[
        lineup as keyof typeof this.data.lineups
      ]) {
        if (player.steam_id === "0") {
          continue;
        }

        players.push({
          discord_id: player.name,
          captain: player.captain,
          steam_id: player.steam_id,
          match_lineup_id:
            lineup === "lineup_1" ? match.lineup_1_id : match.lineup_2_id,
        });

        // add player to the system
        await this.hasura.mutation({
          insert_players_one: {
            __args: {
              object: {
                name: player.name,
                steam_id: player.steam_id,
              },
              on_conflict: {
                constraint: "players_steam_id_key",
                update_columns: ["name"],
                // See PlayerConnected.ts -- the _or is load bearing because
                // name_registered is nullable with no default.
                where: {
                  _or: [
                    { name_registered: { _is_null: true } },
                    { name_registered: { _eq: false } },
                  ],
                },
              },
            },
            __typename: true,
          },
        });
      }
    }

    // A short-handed custom-mode match legitimately reports fewer players than
    // the type expects; measuring against the type would throw the whole roster
    // away and leave the lineups stale.
    const expected =
      match.options.min_players_per_lineup ??
      resolvePlayersPerTeam(match.options.type, match.options.game_mode);

    if (players.length < expected * 2) {
      return;
    }

    // remove anyone not in the match
    await this.hasura.mutation({
      delete_match_lineup_players: {
        __args: {
          where: {
            match_lineup_id: {
              _in: [match.lineup_1_id, match.lineup_2_id],
            },
            steam_id: {
              _nin: players.map(({ steam_id }) => {
                return steam_id;
              }),
            },
          },
        },
        affected_rows: true,
      },
    });

    const newPlayers = [];
    for (const player of players) {
      if (
        match.lineup_players.find((_player) => {
          return _player.steam_id === player.steam_id;
        })
      ) {
        // player already is in the match
        continue;
      }

      newPlayers.push(player);
    }

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: newPlayers,
        },
        affected_rows: true,
      },
    });
  }
}
