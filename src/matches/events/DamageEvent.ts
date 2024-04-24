import MatchEventProcessor from './abstracts/MatchEventProcessor';

export default class DamageEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  attacker_steam_id: bigint;
  attacker_team: string;
  attacker_location: string;
  attacker_location_coordinates: string;
  weapon: string;
  damage: number;
  damage_armor: number;
  health: number;
  armor: number;
  hitgroup: string;
  attacked_steam_id: bigint;
  attacked_team: string;
  attacked_location: string;
  attacked_location_coordinates: string;
  match_map_id: string;
}> {
  public async process() {
    const attacker_data = {
      attacker_team: this.data.attacker_team,
      attacker_steam_id: this.data.attacker_steam_id,
      attacker_location: this.data.attacker_location,
      attacker_location_coordinates: this.data.attacker_location_coordinates,
    };

    await this.hasura.mutation({
      insert_player_damages_one: [
        {
          object: {
            time: new Date(this.data.time),
            match_id: this.matchId,
            round: this.data.round,
            match_map_id: this.data.match_map_id,
            with: this.data.weapon,

            ...(this.data.attacker_steam_id ? attacker_data : {}),

            attacked_steam_id: this.data.attacked_steam_id,
            attacked_team: this.data.attacked_team,
            attacked_location: this.data.attacked_location,

            damage: this.data.damage,
            damage_armor: this.data.damage_armor,
            health: this.data.health,
            armor: this.data.armor,

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
