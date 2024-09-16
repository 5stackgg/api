import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class MatchAbandoned extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_abandoned_matches_one: {
        __args: {
          object: {
            steam_id: this.data.steam_id,
          },
        },
        __typename: true,
      },
    });
  }
}
