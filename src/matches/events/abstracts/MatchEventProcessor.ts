import { Injectable, Logger, Scope } from "@nestjs/common";
import { HasuraService } from "../../../hasura/hasura.service";
import { MatchAssistantService } from "../../match-assistant/match-assistant.service";
import { MatchSocketsService } from "../../../sockets/match-sockets.service";

@Injectable({ scope: Scope.REQUEST })
export default abstract class MatchEventProcessor<T> {
  protected data: T;
  protected matchId: string;

  constructor(
    protected readonly logger: Logger,
    protected readonly hasura: HasuraService,
    protected readonly matchAssistant: MatchAssistantService,
    protected readonly matchSockets: MatchSocketsService,
  ) {}

  public setData(matchId: string, data: T) {
    this.data = data;
    this.matchId = matchId;
  }

  public abstract process(): Promise<void>;
}
