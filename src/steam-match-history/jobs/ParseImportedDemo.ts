import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { DemoParserService } from "../../demos/demo-parser.service";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { MatchImportService } from "../match-import.service";

export type ParseImportedDemoPayload = {
  valve_match_id: string;
  // Carried so the job can run when restarted from BullMQ after the
  // pending_match_imports row was removed (e.g. a prior successful import
  // cleaned it up).
  share_code?: string;
  demo_url?: string | null;
  match_start_time?: string | null;
};

@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.ParseImportedDemo, {
  concurrency: 1,
  limiter: { max: 4, duration: 60_000 },
})
export class ParseImportedDemo extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly demoParser: DemoParserService,
    private readonly matchImport: MatchImportService,
  ) {
    super();
  }

  async process(job: Job<ParseImportedDemoPayload>): Promise<void> {
    const { valve_match_id } = job.data;

    // Already imported — don't reprocess; an admin must delete it to re-import.
    const existing = await this.matchImport.findExistingExternalMatch(
      "valve",
      valve_match_id,
    );
    if (existing) {
      this.logger.log(
        `parse-imported-demo skip valve_match_id=${valve_match_id}: match already imported (${existing}); admin must delete the match to re-import`,
      );
      await this.postgres.query(
        `DELETE FROM public.pending_match_imports WHERE valve_match_id = $1::numeric`,
        [valve_match_id],
      );
      return;
    }

    const rows = await this.postgres.query<
      Array<{
        share_code: string;
        demo_url: string | null;
        match_start_time: string | null;
      }>
    >(
      `SELECT share_code, demo_url, match_start_time
         FROM public.pending_match_imports
        WHERE valve_match_id = $1::numeric`,
      [valve_match_id],
    );
    const row = rows.at(0);

    // Restarting from BullMQ after the pending row was removed: fall back to
    // the data carried on the job payload and just run the import. The status
    // UPDATE / final DELETE below are scoped by valve_match_id so they no-op
    // when there is no row — no need to recreate it.
    const shareCode = row?.share_code ?? job.data.share_code ?? null;
    const matchStartTime =
      row?.match_start_time ?? job.data.match_start_time ?? null;

    const demoUrl = row?.demo_url ?? job.data.demo_url ?? null;

    if (!demoUrl) {
      this.logger.warn(
        `parse-imported-demo no demo url for valve_match_id=${valve_match_id} (no pending row, no payload)`,
      );
      return;
    }

    try {
      await this.postgres.query(
        `UPDATE public.pending_match_imports SET status = 'Parsing', error = NULL WHERE valve_match_id = $1::numeric`,
        [valve_match_id],
      );

      await this.runImport(valve_match_id, shareCode, demoUrl, matchStartTime);
    } catch (err) {
      const lastAttempt =
        (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1) - 1;
      if (lastAttempt) {
        await this.markFailed(
          valve_match_id,
          (err as Error)?.message ?? String(err),
        );
      }
      throw err;
    }
  }

  private async runImport(
    valveMatchId: string,
    shareCode: string | null,
    demoUrl: string,
    matchStartTime: string | null,
  ): Promise<void> {
    const parsed = await this.demoParser.parseFromUrl(demoUrl);
    if (!parsed) {
      throw new Error("demo parse failed");
    }

    const result = await this.matchImport.importExternalDemo(
      parsed,
      "valve",
      shareCode ?? valveMatchId,
      demoUrl,
      matchStartTime,
      valveMatchId,
    );
    if (!result.matchId) {
      throw new Error(result.skipped ?? "import failed");
    }

    await this.postgres.query(
      `DELETE FROM public.pending_match_imports WHERE valve_match_id = $1::numeric`,
      [valveMatchId],
    );

    this.logger.log(
      `parse-imported-demo done valve_match_id=${valveMatchId} match_id=${result.matchId}`,
    );
  }

  private async markFailed(
    valveMatchId: string,
    reason: string,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.pending_match_imports
         SET status = 'Failed', error = $2
       WHERE valve_match_id = $1::numeric`,
      [valveMatchId, reason],
    );
    this.logger.warn(
      `parse-imported-demo failed valve_match_id=${valveMatchId}: ${reason}`,
    );
  }
}
