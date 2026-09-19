import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { e_sides_enum, e_winning_reasons_enum } from "../../../generated";

export default class ScoreEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  match_map_id: number;
  lineup_1_score: number;
  lineup_1_money: number;
  lineup_1_timeouts_available: number;
  lineup_2_score: number;
  lineup_2_money: number;
  lineup_2_timeouts_available: number;
  lineup_1_side: e_sides_enum;
  lineup_2_side: e_sides_enum;
  winning_side: e_sides_enum;
  backup_file: string;
  winning_reason: e_winning_reasons_enum;
}> {
  public async process() {
    // The backend owns the round history. A round at or past this one that is
    // still live means the sender is behind it -- a server restarted into a
    // fresh 0-0 game -- and applying its score would overwrite real rounds and
    // their backups. Rounds replayed after a restore never land here: the
    // restore soft-deleted the ones they replace.
    const { match_map_rounds: recorded } = await this.hasura.query({
      match_map_rounds: {
        __args: {
          where: {
            match_map_id: {
              _eq: this.data.match_map_id,
            },
            round: {
              _gte: this.data.round,
            },
            deleted_at: {
              _is_null: true,
            },
          },
        },
        id: true,
        round: true,
        time: true,
        backup_file: true,
      },
    });

    if (recorded.length > 0) {
      const same = recorded.find((round) => round.round === this.data.round);

      if (
        same &&
        new Date(same.time).getTime() === new Date(this.data.time).getTime()
      ) {
        await this.backfillBackup(same);
        return;
      }

      const latest = Math.max(...recorded.map((round) => round.round));

      this.logger.error(
        `[${this.matchId}] rejected score for round ${this.data.round} of match map ${this.data.match_map_id}: round ${latest} is already recorded, the server is behind`,
      );

      await this.matchAssistant.sendServerMatchId(this.matchId);
      return;
    }

    await this.cleanupData();

    await this.hasura.mutation({
      insert_match_map_rounds_one: {
        __args: {
          object: {
            time: new Date(this.data.time),
            round: this.data.round,
            backup_file: this.usableBackup(),
            match_map_id: this.data.match_map_id,
            lineup_1_score: this.data.lineup_1_score,
            lineup_1_money: this.data.lineup_1_money,
            lineup_1_timeouts_available: this.data.lineup_1_timeouts_available,
            lineup_2_score: this.data.lineup_2_score,
            lineup_2_money: this.data.lineup_2_money,
            lineup_2_timeouts_available: this.data.lineup_2_timeouts_available,
            lineup_1_side: this.data.lineup_1_side,
            lineup_2_side: this.data.lineup_2_side,
            winning_side: this.data.winning_side,
            winning_reason: this.data.winning_reason,
          },
          on_conflict: {
            constraint: "match_rounds_match_id_round_key",
            update_columns: [
              "lineup_1_score",
              "lineup_1_money",
              "lineup_1_timeouts_available",
              "lineup_2_score",
              "lineup_2_money",
              "lineup_2_timeouts_available",
              "lineup_1_side",
              "lineup_2_side",
              "winning_side",
              "backup_file",
            ],
          },
        },
        __typename: true,
      },
    });
  }

  // A redelivered score is the same round again; the only thing it may still
  // add is a backup the first delivery went without.
  private async backfillBackup(round: { id: string; backup_file?: string }) {
    const backupFile = this.usableBackup();

    if (round.backup_file || !backupFile) {
      return;
    }

    await this.hasura.mutation({
      update_match_map_rounds_by_pk: {
        __args: {
          pk_columns: {
            id: round.id,
          },
          _set: {
            backup_file: backupFile,
          },
        },
        __typename: true,
      },
    });
  }

  // CS2 writes a well-formed file even for a round that ended with nobody
  // seated. Restoring one leaves every player unassigned, so it is stored as
  // no backup at all rather than as something a restore would pick.
  private usableBackup(): string {
    const backupFile = this.data.backup_file ?? "";

    const round = /"round"\s+"(\d+)"/.exec(backupFile);

    const usable =
      round !== null &&
      parseInt(round[1]) === Number(this.data.round) &&
      ["PlayersOnTeam1", "PlayersOnTeam2"].every((team) =>
        new RegExp(`"${team}"\\s*\\{\\s*"[^"]+"\\s*\\{`).test(backupFile),
      );

    if (!usable && backupFile !== "") {
      this.logger.error(
        `[${this.matchId}] discarding unusable backup for round ${this.data.round} of match map ${this.data.match_map_id}`,
      );
    }

    return usable ? backupFile : "";
  }

  private async cleanupData() {
    await this.hasura.mutation({
      delete_match_map_rounds: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_kills: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_assists: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_damages: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_flashes: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_utility: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_objectives: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
      delete_player_unused_utility: {
        __args: {
          where: {
            deleted_at: {
              _is_null: false,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        __typename: true,
      },
    });
  }
}
