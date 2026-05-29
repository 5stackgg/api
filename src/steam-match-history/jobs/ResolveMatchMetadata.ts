import { Job } from "bullmq";
import { InjectQueue, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { SteamGcService } from "../steam-gc.service";
import { MatchImportService } from "../match-import.service";
import { ParseImportedDemo } from "./ParseImportedDemo";

export type ResolveMatchMetadataPayload = {
  valve_match_id: string;
};

@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.ResolveMatchMetadata, {
  concurrency: 1,
  limiter: { max: 30, duration: 60_000 },
})
export class ResolveMatchMetadata extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly steamGc: SteamGcService,
    private readonly matchImport: MatchImportService,
    @InjectQueue(SteamMatchHistoryQueues.ParseImportedDemo)
    private readonly parseQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ResolveMatchMetadataPayload>): Promise<void> {
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
      return;
    }

    // Already resolved (retry path) — straight to parse.
    if (row.demo_url) {
      await this.enqueueParse(valve_match_id);
      return;
    }

    if (!this.steamGc.isAvailable()) {
      await this.markFailed(valve_match_id, "steam gc not configured");
      return;
    }

    const resolved = await this.steamGc.resolveShareCode(row.share_code);
    if (!resolved) {
      await this.markFailed(valve_match_id, "gc returned no demo url");
      return;
    }

    const matchStartTime =
      resolved.matchStartTime ??
      (await this.matchImport.resolveDemoStartTime(resolved.demoUrl));

    this.logger.log(
      `resolved valve_match_id=${valve_match_id} map=${resolved.mapName ?? "<none>"} matchStartTime=${matchStartTime ?? "<none>"} [source=${resolved.matchStartTime ? "gc-matchtime" : matchStartTime ? "demo-cdn-last-modified" : "none"}] demoUrl=${resolved.demoUrl}`,
    );

    await this.postgres.query(
      `UPDATE public.pending_match_imports
         SET map_name = $2,
             match_start_time = $3,
             demo_url = $4
       WHERE valve_match_id = $1::numeric`,
      [valve_match_id, resolved.mapName, matchStartTime, resolved.demoUrl],
    );

    await this.enqueueParse(valve_match_id);
  }

  private async enqueueParse(valveMatchId: string): Promise<void> {
    const jobId = `parse-${valveMatchId}`;
    await this.parseQueue.remove(jobId).catch(() => {});
    await this.parseQueue.add(
      ParseImportedDemo.name,
      { valve_match_id: valveMatchId },
      { jobId, attempts: 1 },
    );
  }

  private async markFailed(
    valveMatchId: string,
    reason: string,
  ): Promise<void> {
    // No match exists yet at the resolve stage (it's created later during
    // parse/import), so there is nothing to clean up here beyond the status.
    await this.postgres.query(
      `UPDATE public.pending_match_imports
         SET status = 'Failed', error = $2
       WHERE valve_match_id = $1::numeric`,
      [valveMatchId, reason],
    );
    this.logger.warn(
      `resolve-match-metadata failed valve_match_id=${valveMatchId}: ${reason}`,
    );
  }
}
