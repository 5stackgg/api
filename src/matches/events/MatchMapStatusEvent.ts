import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { e_match_map_status_enum } from "../../../generated";
import { HasuraService } from "../../hasura/hasura.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { Logger } from "@nestjs/common";
import { ChatService } from "../../chat/chat.service";
import { NotificationsService } from "../../notifications/notifications.service";

export default class MatchMapStatusEvent extends MatchEventProcessor<{
  status: e_match_map_status_enum;
  winning_lineup_id?: string;
}> {
  constructor(
    logger: Logger,
    hasura: HasuraService,
    matchAssistant: MatchAssistantService,
    chat: ChatService,
    private readonly notifications: NotificationsService,
  ) {
    super(logger, hasura, matchAssistant, chat);
  }

  public async process() {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: this.matchId,
        },
        current_match_map_id: true,
      },
    });

    if (!match?.current_match_map_id) {
      return;
    }

    const isFinished = this.data.status === "Finished";

    const { update_match_maps_by_pk } = await this.hasura.mutation({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: {
            id: match.current_match_map_id,
          },
          _set: {
            status: this.data.status,
            ...(this.data.winning_lineup_id
              ? { winning_lineup_id: this.data.winning_lineup_id }
              : {}),
          },
        },
        id: true,
        match: {
          current_match_map_id: true,
        },
      },
    });

    if (this.data.status === "Paused") {
      void this.notifications.sendMatchMapPauseNotification(this.matchId);
    }

    if (isFinished) {
      if (update_match_maps_by_pk.match.current_match_map_id !== null) {
        await this.matchAssistant.sendServerMatchId(this.matchId);
        return;
      }
    }
  }
}
