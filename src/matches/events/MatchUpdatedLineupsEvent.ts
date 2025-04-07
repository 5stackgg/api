import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";
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
              },
            },
            __typename: true,
          },
        });
      }
    }

    if (players.length < ExpectedPlayers[match.options.type] * 2) {
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
