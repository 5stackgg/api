import { randomUUID } from "crypto";
import { Job, UnrecoverableError } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { DemoParserService } from "../../demos/demo-parser.service";
import { playbackRequest } from "../../demos/demo-metadata.service";
import { S3Service } from "../../s3/s3.service";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { MatchImportService } from "../match-import.service";

export type ProcessUploadedDemoPayload = {
  key: string;
  file_name: string;
  steam_id: string;
  external_id?: string;
  source?: "faceit";
  match_start_time?: string | null;
  match_id?: string;
};

@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.ProcessUploadedDemo, {
  concurrency: 1,
  limiter: { max: 4, duration: 60_000 },
})
export class ProcessUploadedDemo extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly demoParser: DemoParserService,
    private readonly matchImport: MatchImportService,
    private readonly s3: S3Service,
  ) {
    super();
  }

  async process(job: Job<ProcessUploadedDemoPayload>): Promise<void> {
    const { key, file_name, steam_id, external_id, source, match_start_time } =
      job.data;
    const lastAttempt = (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1) - 1;

    try {
      this.logger.log(`process-uploaded-demo steam_id=${steam_id} key=${key}`);

      // Reserved before the parse so the parser can build the playback blob
      // for the match map the import is about to create.
      const matchMapId = randomUUID();
      const parsed = await this.demoParser.parseFromS3Key(
        key,
        undefined,
        playbackRequest(matchMapId),
      );
      if (!parsed) {
        throw new Error("demo failed to parse");
      }

      const dedupeKey =
        external_id ??
        MatchImportService.extractFaceitMatchId(file_name) ??
        file_name
          .replace(/^.*\//, "")
          .replace(/\.dem$/i, "")
          .replace(/[^a-zA-Z0-9_-]/g, "_");

      const result = await this.matchImport.importExternalDemo(
        parsed,
        source ?? "valve",
        dedupeKey,
        {
          matchStartTime: match_start_time ?? null,
          externalId: dedupeKey,
          sourceObjectKey: key,
          matchMapId,
        },
      );

      this.logger.log(
        `process-uploaded-demo done steam_id=${steam_id} match_id=${result.matchId ?? "<none>"}${result.skipped ? ` skipped=${result.skipped}` : ""}`,
      );

      // The queue drops a job's return value, so the extension's status lookup
      // reads the outcome off the job: a skip as its failure reason, and the
      // match, which a duplicate demo resolves to under another external id.
      if (external_id) {
        if (!result.matchId) {
          throw new UnrecoverableError(
            result.skipped ?? "demo was not imported",
          );
        }
        await job.updateData({ ...job.data, match_id: result.matchId });
      }

      await this.s3.remove(key);
    } catch (error) {
      if (lastAttempt || error instanceof UnrecoverableError) {
        await this.s3.remove(key);
        this.logger.warn(
          `process-uploaded-demo failed steam_id=${steam_id} key=${key}: ${(error as Error)?.message ?? error}`,
        );
      }
      throw error;
    }
  }
}
