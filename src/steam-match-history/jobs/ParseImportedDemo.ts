import { randomUUID } from "crypto";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { DemoParserService } from "../../demos/demo-parser.service";
import { playbackRequest } from "../../demos/demo-metadata.service";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { MatchImportService } from "../match-import.service";
import { decodeShareCode } from "../shareCode";

export type ParseImportedDemoPayload = {
  valve_match_id: string;
  // Carried so the job can run when restarted from BullMQ after the
  // pending_match_imports row was removed (e.g. a prior successful import
  // cleaned it up).
  share_code?: string;
  demo_url?: string | null;
  match_start_time?: string | null;
};

// Two at a time: a burst of finished matches otherwise waits in line behind
// one ~30s parse each. Jobs are keyed parse-<valve match id>, so one match is
// never imported twice at once, and the parser serializes downloads per Valve
// replay host by itself. A parse peaks around 370 MB in the parser.
@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.ParseImportedDemo, {
  concurrency: 2,
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
    // Jobs queued before the share-code alphabet fix carry a wrong id.
    const valve_match_id = job.data.share_code
      ? decodeShareCode(job.data.share_code).matchId.toString()
      : job.data.valve_match_id;

    // Already imported — don't reprocess; an admin must delete it to re-import.
    const existing = await this.matchImport.findExistingExternalMatch(
      "valve",
      valve_match_id,
    );
    if (existing) {
      this.logger.log(
        `parse-imported-demo skip valve_match_id=${valve_match_id}: match already imported (${existing}); admin must delete the match to re-import`,
      );
      // The pending row is about to go and it holds the only copy of the share
      // code, which is our one stable handle on this match. Harvest it first.
      const pending = await this.postgres.query<Array<{ share_code: string }>>(
        `SELECT share_code
           FROM public.pending_match_imports
          WHERE valve_match_id = $1::numeric`,
        [valve_match_id],
      );
      await this.matchImport.persistShareCode(
        existing,
        pending.at(0)?.share_code ?? job.data.share_code,
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
    const startedAt = Date.now();
    // Reserved before the parse so the parser can build the playback blob for
    // the match map the import is about to create.
    const matchMapId = randomUUID();
    const parsed = await this.demoParser.parseFromUrl(
      demoUrl,
      playbackRequest(matchMapId),
    );
    if (!parsed) {
      throw new Error("demo parse failed");
    }
    const parsedAt = Date.now();

    const result = await this.matchImport.importExternalDemo(
      parsed,
      "valve",
      shareCode ?? valveMatchId,
      {
        demoUrl,
        matchStartTime,
        externalId: valveMatchId,
        shareCode,
        matchMapId,
      },
    );
    if (!result.matchId) {
      throw new Error(result.skipped ?? "import failed");
    }

    await this.postgres.query(
      `DELETE FROM public.pending_match_imports WHERE valve_match_id = $1::numeric`,
      [valveMatchId],
    );

    const doneAt = Date.now();
    this.logger.log(
      `parse-imported-demo done valve_match_id=${valveMatchId} match_id=${result.matchId} ` +
        `in ${((doneAt - startedAt) / 1000).toFixed(1)}s (parse ${((parsedAt - startedAt) / 1000).toFixed(1)}s, import ${((doneAt - parsedAt) / 1000).toFixed(1)}s)`,
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
