import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class UnusedUtility extends MatchEventProcessor<void> {
  public async process() {
    console.info("UNUSED UTILITY", this.data);
  }
}
