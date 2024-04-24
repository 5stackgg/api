import MatchEventProcessor from './abstracts/MatchEventProcessor';

export default class FlashEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  attacker_steam_id: bigint;
  attacked_steam_id: bigint;
  match_map_id: string;
  duration: number;
  team_flash: boolean;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_player_flashes_one: [
        {
          object: {
            time: new Date(this.data.time),
            match_id: this.matchId,
            match_map_id: this.data.match_map_id,
            round: this.data.round,
            attacker_steam_id: this.data.attacker_steam_id,
            attacked_steam_id: this.data.attacked_steam_id,
            duration: this.data.duration,
            team_flash: this.data.team_flash,
          },
        },
        {
          id: true,
        },
      ],
    });
  }
}
