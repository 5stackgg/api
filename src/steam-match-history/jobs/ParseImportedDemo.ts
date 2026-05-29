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

    const rows = await this.postgres.query<
      Array<{ share_code: string; demo_url: string | null }>
    >(
      `SELECT share_code, demo_url
         FROM public.pending_match_imports
        WHERE valve_match_id = $1::numeric`,
      [valve_match_id],
    );
    const row = rows.at(0);
    if (!row) {
      this.logger.warn(
        `parse-imported-demo no pending row for valve_match_id=${valve_match_id}`,
      );
      return;
    }
    if (!row.demo_url) {
      await this.markFailed(
        valve_match_id,
        row.share_code,
        "no demo url cached — resolve step missing",
      );
      return;
    }

    await this.postgres.query(
      `UPDATE public.pending_match_imports SET status = 'Parsing', error = NULL WHERE valve_match_id = $1::numeric`,
      [valve_match_id],
    );

    try {
      await this.runImport(valve_match_id, row.share_code, row.demo_url);
    } catch (err) {
      await this.markFailed(
        valve_match_id,
        row.share_code,
        (err as Error)?.message ?? String(err),
        row.demo_url,
      );
      throw err;
    }
  }

  private async runImport(
    valveMatchId: string,
    shareCode: string,
    demoUrl: string,
  ): Promise<void> {
    // Skip the demo download + parse entirely if this match was already
    // imported (the demo row is keyed by its url).
    const existing = await this.postgres.query<Array<{ match_id: string }>>(
      `SELECT match_id FROM public.match_map_demos WHERE file = $1 LIMIT 1`,
      [demoUrl],
    );
    if (existing.length > 0) {
      this.logger.log(
        `parse-imported-demo skip valve_match_id=${valveMatchId}: already imported as match ${existing[0].match_id}`,
      );
      await this.postgres.query(
        `DELETE FROM public.pending_match_imports WHERE valve_match_id = $1::numeric`,
        [valveMatchId],
      );
      return;
    }

    const parsed = await this.demoParser.parseFromUrl(demoUrl);
    if (!parsed) {
      await this.markFailed(
        valveMatchId,
        shareCode,
        "demo parse failed",
        demoUrl,
      );
      return;
    }

    const meta = await this.postgres.query<
      Array<{ match_start_time: string | null }>
    >(
      `SELECT match_start_time FROM public.pending_match_imports WHERE share_code = $1 LIMIT 1`,
      [shareCode],
    );
    const matchStartTime = meta.at(0)?.match_start_time ?? null;

    const result = await this.matchImport.importExternalDemo(
      parsed,
      "valve",
      shareCode,
      demoUrl,
      matchStartTime,
    );
    if (!result.matchId) {
      await this.markFailed(
        valveMatchId,
        shareCode,
        result.skipped ?? "import failed",
        demoUrl,
      );
      return;
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
    shareCode: string,
    reason: string,
    demoUrl?: string | null,
  ): Promise<void> {
    // importExternalDemo rolls back its own partial match by id on throw, but
    // delete defensively here too so a failed import never leaves match data
    // behind. The demo row is keyed by the demo url, with the share-code path
    // as a fallback for older rows.
    const files = [demoUrl, `external/valve/${shareCode}.dem`].filter(
      (f): f is string => !!f,
    );
    await this.postgres.query(
      `DELETE FROM public.matches
         WHERE id IN (
           SELECT match_id FROM public.match_map_demos WHERE file = ANY($1::text[])
         )`,
      [files],
    );
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
