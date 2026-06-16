import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { e_sides_enum } from "../../../generated";

type ConnectedPlayer = {
  steam_id: string;
  player_name: string;
  team: string;
  lineup_id: string;
};

type LineupPlayer = {
  id: string;
  steam_id?: string | null;
  placeholder_name?: string | null;
  discord_id?: string | null;
  match_lineup_id: string;
};

export default class PlayersConnected extends MatchEventProcessor<{
  status: string;
  players: ConnectedPlayer[];
}> {
  public async process() {
    const players = this.data.players ?? [];

    if (players.length === 0) {
      return;
    }

    await this.hasura.mutation({
      insert_players: {
        __args: {
          objects: players.map((player) => ({
            name: player.player_name,
            steam_id: player.steam_id,
          })),
          on_conflict: {
            constraint: "players_steam_id_key",
            update_columns: ["name"],
          },
        },
        affected_rows: true,
      },
    });

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: this.matchId },
        lineup_1_id: true,
        lineup_2_id: true,
        current_match_map_id: true,
        lineup_1: {
          lineup_players: {
            id: true,
            steam_id: true,
            placeholder_name: true,
            discord_id: true,
            match_lineup_id: true,
          },
        },
        lineup_2: {
          lineup_players: {
            id: true,
            steam_id: true,
            placeholder_name: true,
            discord_id: true,
            match_lineup_id: true,
          },
        },
      },
    });

    if (!match) {
      return;
    }

    const lineupPlayers: LineupPlayer[] = [
      ...match.lineup_1.lineup_players,
      ...match.lineup_2.lineup_players,
    ];

    const usedSteamIds = new Set<string>(
      lineupPlayers
        .filter((lineupPlayer) => lineupPlayer.steam_id != null)
        .map((lineupPlayer) => lineupPlayer.steam_id.toString()),
    );

    const teamToLineupId = await this.getTeamToLineupId(match);

    const placeholders = lineupPlayers.filter(
      (lineupPlayer) => lineupPlayer.steam_id == null,
    );

    const candidates = players.filter(
      (player) => !usedSteamIds.has(player.steam_id),
    );

    const resolved = new Map<string, string>();
    const claimedSteamIds = new Set<string>();

    const claim = (placeholder: LineupPlayer, player: ConnectedPlayer) => {
      resolved.set(placeholder.id, player.steam_id);
      claimedSteamIds.add(player.steam_id);
    };

    const candidateLineupId = (player: ConnectedPlayer) =>
      player.lineup_id || teamToLineupId[player.team] || null;

    const available = () =>
      candidates.filter((player) => !claimedSteamIds.has(player.steam_id));

    for (const placeholder of placeholders) {
      const picked = available().find((player) =>
        this.namesMatch(player.player_name, placeholder.placeholder_name),
      );

      if (picked) {
        claim(placeholder, picked);
      }
    }

    for (const placeholder of placeholders) {
      if (resolved.has(placeholder.id)) {
        continue;
      }

      const picked = available().find(
        (player) => candidateLineupId(player) === placeholder.match_lineup_id,
      );

      if (picked) {
        claim(placeholder, picked);
      }
    }

    for (const placeholder of placeholders) {
      const steamId = resolved.get(placeholder.id);

      if (!steamId) {
        this.logger.warn(
          `PlayersConnected unresolved placeholder match=${this.matchId} placeholder_name=${placeholder.placeholder_name}`,
        );
        continue;
      }

      await this.hasura.mutation({
        update_match_lineup_players_by_pk: {
          __args: {
            pk_columns: { id: placeholder.id },
            _set: {
              steam_id: steamId,
              placeholder_name: null,
            },
          },
          id: true,
        },
      });
    }

    for (const player of available()) {
      this.logger.log(
        `PlayersConnected unmatched player match=${this.matchId} steam_id=${player.steam_id} player_name=${player.player_name}`,
      );
    }
  }

  private async getTeamToLineupId(match: {
    lineup_1_id: string;
    lineup_2_id: string;
    current_match_map_id?: string | null;
  }): Promise<Partial<Record<string, string>>> {
    if (!match.current_match_map_id) {
      return {};
    }

    const { match_maps_by_pk: matchMap } = await this.hasura.query({
      match_maps_by_pk: {
        __args: { id: match.current_match_map_id },
        lineup_1_side: true,
        lineup_2_side: true,
      },
    });

    if (!matchMap) {
      return {};
    }

    return {
      [matchMap.lineup_1_side as e_sides_enum]: match.lineup_1_id,
      [matchMap.lineup_2_side as e_sides_enum]: match.lineup_2_id,
    };
  }

  private namesMatch(playerName?: string | null, placeholderName?: string | null) {
    const a = (playerName ?? "").trim().toLowerCase();
    const b = (placeholderName ?? "").trim().toLowerCase();

    if (a.length < 2 || b.length < 2) {
      return false;
    }

    return a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
  }
}
