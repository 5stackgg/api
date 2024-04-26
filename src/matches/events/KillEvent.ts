import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class KillEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  attacker_steam_id: bigint;
  attacker_team: string;
  attacker_location: string;
  attacker_location_coordinates: string;
  weapon: string;
  hitgroup: string;
  attacked_steam_id: bigint;
  attacked_team: string;
  attacked_location: string;
  attacked_location_coordinates: string;
  match_map_id: string;
  no_scope: boolean;
  blinded: boolean;
  thru_smoke: boolean;
  thru_wall: boolean;
  headshot: boolean;
  assisted: boolean;
  in_air: boolean;
}> {
  public async process() {
    const attacker_data = {
      attacker_team: this.data.attacker_team,
      attacker_steam_id: this.data.attacker_steam_id,
      attacker_location: this.data.attacker_location,
      attacker_location_coordinates: this.data.attacker_location_coordinates,
    };

    await this.hasura.mutation({
      insert_player_kills_one: [
        {
          object: {
            time: new Date(this.data.time),
            match_id: this.matchId,
            match_map_id: this.data.match_map_id,
            round: this.data.round,
            with: this.data.weapon,
            no_scope: this.data.no_scope,
            blinded: this.data.blinded,
            thru_smoke: this.data.thru_smoke,
            thru_wall: this.data.thru_wall,
            in_air: this.data.in_air,
            headshot: this.data.headshot,
            assisted: this.data.assisted,

            ...(this.data.attacker_steam_id ? attacker_data : {}),

            attacked_steam_id: this.data.attacked_steam_id,
            attacked_team: this.data.attacked_team,
            attacked_location: this.data.attacked_location,
            attacked_location_coordinates: this.data
              .attacked_location_coordinates,

            hitgroup: this.data.hitgroup,
          },
        },
        {
          id: true,
        },
      ],
    });
  }
}
