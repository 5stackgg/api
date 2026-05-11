import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { e_match_map_status_enum } from "../../../generated";

export default class MatchMapStatusEvent extends MatchEventProcessor<{
  status: e_match_map_status_enum;
  winning_lineup_id?: string;
}> {
  public async process() {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: this.matchId,
        },
        current_match_map_id: true,
        lineup_1_id: true,
        lineup_2_id: true,
      },
    });

    if (!match?.current_match_map_id) {
      return;
    }

    const isFinished = this.data.status === "Finished";

    let resolvedWinningLineupId: string | undefined = this.data.winning_lineup_id;

    if (isFinished) {
      const { match_map_rounds } = await this.hasura.query({
        match_map_rounds: {
          __args: {
            where: {
              match_map_id: {
                _eq: match.current_match_map_id,
              },
            },
            order_by: [{ time: "desc" }],
            limit: 1,
          },
          lineup_1_score: true,
          lineup_2_score: true,
        },
      });

      const lastRound = match_map_rounds?.[0];
      const lineup1Score = lastRound?.lineup_1_score ?? 0;
      const lineup2Score = lastRound?.lineup_2_score ?? 0;

      let scoreDerivedWinner: string | null = null;
      if (lineup1Score > lineup2Score) {
        scoreDerivedWinner = match.lineup_1_id;
      } else if (lineup2Score > lineup1Score) {
        scoreDerivedWinner = match.lineup_2_id;
      }

      const reported = this.data.winning_lineup_id;

      if (scoreDerivedWinner) {
        if (reported && reported !== scoreDerivedWinner) {
          this.logger.warn(
            `MatchMapStatusEvent winner mismatch match=${this.matchId} match_map=${match.current_match_map_id} ` +
              `reported=${reported} score_derived=${scoreDerivedWinner} ` +
              `lineup_1_score=${lineup1Score} lineup_2_score=${lineup2Score} - overriding with score_derived`,
          );
        } else if (!reported) {
          this.logger.log(
            `MatchMapStatusEvent no reported winner match=${this.matchId} match_map=${match.current_match_map_id} ` +
              `using score_derived=${scoreDerivedWinner} (${lineup1Score}-${lineup2Score})`,
          );
        }
        resolvedWinningLineupId = scoreDerivedWinner;
      } else if (reported) {
        this.logger.warn(
          `MatchMapStatusEvent scores tied or missing match=${this.matchId} match_map=${match.current_match_map_id} ` +
            `lineup_1_score=${lineup1Score} lineup_2_score=${lineup2Score} reported=${reported} - keeping reported value`,
        );
      }
    }

    const { update_match_maps_by_pk } = await this.hasura.mutation({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: {
            id: match.current_match_map_id,
          },
          _set: {
            status: this.data.status,
            ...(resolvedWinningLineupId
              ? { winning_lineup_id: resolvedWinningLineupId }
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
      await this.logMatchEndIfFinished();
      if (update_match_maps_by_pk.match.current_match_map_id !== null) {
        await this.matchAssistant.sendServerMatchId(this.matchId);
        return;
      }
    }
  }

  private async logMatchEndIfFinished() {
    const { matches_by_pk: matchAfter } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: this.matchId },
        status: true,
        winning_lineup_id: true,
        lineup_1_id: true,
        lineup_2_id: true,
        options: { best_of: true },
        match_maps: {
          id: true,
          status: true,
          winning_lineup_id: true,
          lineup_1_score: true,
          lineup_2_score: true,
        },
      },
    });

    if (
      !matchAfter ||
      matchAfter.status !== "Finished" ||
      !matchAfter.winning_lineup_id
    ) {
      return;
    }

    const lineup1Id = matchAfter.lineup_1_id;
    const lineup2Id = matchAfter.lineup_2_id;
    const bestOf = matchAfter.options?.best_of ?? 0;

    let lineup1Wins = 0;
    let lineup2Wins = 0;
    const mapSummaries: string[] = [];

    for (const map of matchAfter.match_maps ?? []) {
      const l1 = map.lineup_1_score ?? 0;
      const l2 = map.lineup_2_score ?? 0;
      let scoreWinner: string | null = null;
      if (l1 > l2) {
        scoreWinner = lineup1Id;
        lineup1Wins += 1;
      } else if (l2 > l1) {
        scoreWinner = lineup2Id;
        lineup2Wins += 1;
      }
      const stored = map.winning_lineup_id ?? null;
      const mismatch =
        scoreWinner && stored && scoreWinner !== stored ? " MISMATCH" : "";
      mapSummaries.push(
        `map=${map.id} status=${map.status} score=${l1}-${l2} ` +
          `score_winner=${scoreWinner ?? "<tie>"} stored=${stored ?? "<null>"}${mismatch}`,
      );
    }

    const tieDefaultedToLineup2 = lineup1Wins === lineup2Wins;
    const apiDerivedWinner =
      lineup1Wins > lineup2Wins ? lineup1Id : lineup2Id;
    const sqlDisagrees = apiDerivedWinner !== matchAfter.winning_lineup_id;

    const summaryLine =
      `match end match=${this.matchId} sql_winner=${matchAfter.winning_lineup_id} ` +
      `api_derived_winner=${apiDerivedWinner} best_of=${bestOf} ` +
      `lineup_1_wins=${lineup1Wins} lineup_2_wins=${lineup2Wins} ` +
      `tie_defaulted_to_lineup_2=${tieDefaultedToLineup2} ` +
      `maps=[${mapSummaries.join(" | ")}]`;

    if (sqlDisagrees || tieDefaultedToLineup2) {
      this.logger.warn(summaryLine);
    } else {
      this.logger.log(summaryLine);
    }
  }
}
