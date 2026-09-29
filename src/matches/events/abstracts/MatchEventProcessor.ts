import { Injectable, Logger, Scope } from "@nestjs/common";
import { HasuraService } from "../../../hasura/hasura.service";
import { MatchAssistantService } from "../../match-assistant/match-assistant.service";
import { ChatService } from "../../../chat/chat.service";
import { NotificationsService } from "../../../notifications/notifications.service";
import type { players_on_conflict } from "../../../../generated";

@Injectable({ scope: Scope.REQUEST })
export default abstract class MatchEventProcessor<T> {
  protected data: T;
  protected matchId: string;

  constructor(
    protected readonly logger: Logger,
    protected readonly hasura: HasuraService,
    protected readonly matchAssistant: MatchAssistantService,
    protected readonly chat: ChatService,
    protected readonly notifications: NotificationsService,
  ) {}

  public setData(matchId: string, data: T) {
    this.data = data;
    this.matchId = matchId.trim();
  }

  public abstract process(): Promise<void>;

  // A server only refreshes the names of its own match's players; anyone else
  // it reports is created if missing but keeps their name. Registered names
  // are never overwritten, and name_registered is nullable with no default,
  // so a bare _eq: false would match nothing and end name refresh for everyone.
  protected playerNameConflict(): players_on_conflict {
    return {
      constraint: "players_steam_id_key",
      update_columns: ["name"],
      where: {
        _or: [
          { name_registered: { _is_null: true } },
          { name_registered: { _eq: false } },
        ],
        player_lineup: {
          lineup: {
            match_id: { _eq: this.matchId },
          },
        },
      },
    };
  }
}
