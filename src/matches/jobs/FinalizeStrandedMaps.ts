import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { e_match_map_status_enum } from "../../../generated";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class FinalizeStrandedMaps extends WorkerHost {
  // The game server is the only thing that writes Finished, and it does so at
  // the very end of a handshake it runs entirely in-process: WaitingForTV for
  // tv_delay, then stop demo -> UploadingDemo, then upload -> Finished. If its
  // pod dies anywhere in that window (auto-cancel, crash, eviction, node drain)
  // the map strands, update_match_state never runs, the series never resolves
  // and the server is never released. Past this deadline we finish the map from
  // the result the server already published when the game ended.
  private static readonly PLUGIN_HANDSHAKE_SECONDS = 20;
  private static readonly GRACE_SECONDS = 300;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const { match_maps } = await this.hasura.query({
      match_maps: {
        __args: {
          where: {
            status: {
              _in: [
                "WaitingForTV",
                "UploadingDemo",
              ] as e_match_map_status_enum[],
            },
            match: {
              status: {
                _nin: [
                  "Finished",
                  "Canceled",
                  "Forfeit",
                  "Tie",
                  "Surrendered",
                ],
              },
            },
          },
        },
        id: true,
        status: true,
        match_id: true,
        winning_lineup_id: true,
        lineup_1_score: true,
        lineup_2_score: true,
        match: {
          lineup_1_id: true,
          lineup_2_id: true,
          options: {
            tv_delay: true,
          },
        },
        rounds: {
          __args: {
            order_by: [{ time: "desc" }],
            limit: 1,
          },
          time: true,
        },
      },
    });

    let finalized = 0;

    for (const matchMap of match_maps) {
      const lastRoundAt = matchMap.rounds?.at(0)?.time;

      if (!lastRoundAt) {
        continue;
      }

      const deadline =
        new Date(lastRoundAt).getTime() +
        ((matchMap.match?.options?.tv_delay ?? 0) +
          FinalizeStrandedMaps.PLUGIN_HANDSHAKE_SECONDS +
          FinalizeStrandedMaps.GRACE_SECONDS) *
          1000;

      if (Date.now() < deadline) {
        continue;
      }

      const winningLineupId = this.resolveWinningLineupId(matchMap);

      this.logger.warn(
        `[${matchMap.match_id}] map ${matchMap.id} stranded in ${matchMap.status} ` +
          `since ${lastRoundAt} — finalizing without the server ` +
          `(score ${matchMap.lineup_1_score ?? 0}-${matchMap.lineup_2_score ?? 0}, ` +
          `winner ${winningLineupId ?? "<tie>"})`,
      );

      await this.hasura.mutation({
        update_match_maps_by_pk: {
          __args: {
            pk_columns: {
              id: matchMap.id,
            },
            _set: {
              status: "Finished",
              ...(winningLineupId
                ? { winning_lineup_id: winningLineupId }
                : {}),
            },
          },
          __typename: true,
        },
      });

      finalized++;
    }

    return finalized;
  }

  // The server publishes the winner alongside the WaitingForTV status, so the
  // stored value is authoritative when present; scores are the fallback for
  // maps that stranded before that landed.
  private resolveWinningLineupId(matchMap: {
    winning_lineup_id?: string | null;
    lineup_1_score?: number | null;
    lineup_2_score?: number | null;
    match?: {
      lineup_1_id?: string | null;
      lineup_2_id?: string | null;
    } | null;
  }) {
    if (matchMap.winning_lineup_id) {
      return matchMap.winning_lineup_id;
    }

    const lineup1Score = matchMap.lineup_1_score ?? 0;
    const lineup2Score = matchMap.lineup_2_score ?? 0;

    if (lineup1Score > lineup2Score) {
      return matchMap.match?.lineup_1_id ?? null;
    }

    if (lineup2Score > lineup1Score) {
      return matchMap.match?.lineup_2_id ?? null;
    }

    return null;
  }
}
