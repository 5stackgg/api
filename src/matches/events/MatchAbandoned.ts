import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { NotificationsService } from "../../notifications/notifications.service";

export default class MatchAbandoned extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    // The plugin re-arms its disconnect timer per reconnect and per map, so one
    // leave can report itself several times. The cooldown counts rows, so a
    // duplicate would escalate the ban for a single offense.
    const { insert_abandoned_matches: inserted } = await this.hasura.mutation({
      insert_abandoned_matches: {
        __args: {
          objects: [
            {
              steam_id: this.data.steam_id,
              match_id: this.matchId,
            },
          ],
          on_conflict: {
            constraint: "abandoned_matches_steam_id_match_id_key",
            update_columns: [],
          },
        },
        affected_rows: true,
      },
    });

    if (!inserted?.affected_rows) {
      return;
    }

    await this.notifyAdmins();
  }

  // Abandons are issued automatically and carry a cooldown that escalates on
  // repeat, so admins need to see them to spot an unfair one before the player
  // has to appeal it.
  private async notifyAdmins() {
    try {
      const { players_by_pk: player } = await this.hasura.query({
        players_by_pk: {
          __args: {
            steam_id: this.data.steam_id,
          },
          name: true,
        },
      });

      await this.notifications.send("MatchAbandoned", {
        message: `${NotificationsService.escapeHtml(player?.name ?? this.data.steam_id)} abandoned a match`,
        title: "Match Abandoned",
        role: "administrator",
        entity_id: this.matchId,
      });
    } catch (error) {
      // The abandon record is the thing that matters; never lose it over a
      // failed notification.
      this.logger.warn(
        `failed to notify admins of abandon by ${this.data.steam_id}`,
        error,
      );
    }
  }
}
