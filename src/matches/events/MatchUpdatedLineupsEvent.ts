import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import {
  players_constraint,
  players_update_column,
} from "../../../generated/zeus";

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

    // TODO - just dlete the ones missing , and inesrt the ones missing
    await this.hasura.mutation({
      delete_match_lineup_players: [
        {
          where: {
            match_lineup_id: {
              _in: [match.lineup_1_id, match.lineup_2_id],
            },
          },
        },
        {
          affected_rows: true,
        },
      ],
    });

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
        players.push({
          discord_id: player.name,
          captain: player.captain,
          steam_id: player.steam_id !== "0" ? player.steam_id : undefined,
          // this shouldn't really happen, but it happens in DEV
          placeholder_name:
            player.steam_id === "0" ? `BOT - ${player.name}` : undefined,
          match_lineup_id:
            lineup === "lineup_1" ? match.lineup_1_id : match.lineup_2_id,
        });

        if (player.steam_id === "0") {
          continue;
        }

        await this.hasura.mutation({
          insert_players_one: [
            {
              object: {
                name: player.name,
                steam_id: player.steam_id,
              },
              on_conflict: {
                constraint: players_constraint.players_steam_id_key,
                update_columns: [players_update_column.name],
              },
            },
            {
              __typename: true,
            },
          ],
        });
      }
    }

    await this.hasura.mutation({
      insert_match_lineup_players: [
        {
          objects: players,
        },
        {
          returning: {
            id: true,
          },
        },
      ],
    });
  }
}
