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
      );
      throw err;
    }
  }

  private async runImport(
    valveMatchId: string,
    shareCode: string,
    demoUrl: string,
  ): Promise<void> {
    const parsed = await this.demoParser.parseFromUrl(demoUrl);
    if (!parsed) {
      await this.markFailed(valveMatchId, shareCode, "demo parse failed");
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
  ): Promise<void> {
    const file = `external/valve/${shareCode}.dem`;
    await this.postgres.query(
      `DELETE FROM public.matches
         WHERE id IN (
           SELECT match_id FROM public.match_map_demos WHERE file = $1
         )`,
      [file],
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
