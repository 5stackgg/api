import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class UnusedUtility extends MatchEventProcessor<void> {
  public async process() {
    this.logger.debug("UNUSED UTILITY", this.data);
  }
}
