import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { DemoParserService } from "../../demos/demo-parser.service";
import { S3Service } from "../../s3/s3.service";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { MatchImportService } from "../match-import.service";

export type ProcessUploadedDemoPayload = {
  key: string;
  file_name: string;
  steam_id: string;
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
    const { key, file_name, steam_id } = job.data;
    const lastAttempt = (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1) - 1;

    try {
      this.logger.log(`process-uploaded-demo steam_id=${steam_id} key=${key}`);

      const parsed = await this.demoParser.parseFromS3Key(key);
      if (!parsed) {
        throw new Error("demo failed to parse");
      }

      const dedupeKey =
        MatchImportService.extractFaceitMatchId(file_name) ??
        file_name
          .replace(/^.*\//, "")
          .replace(/\.dem$/i, "")
          .replace(/[^a-zA-Z0-9_-]/g, "_");

      const result = await this.matchImport.importExternalDemo(
        parsed,
        "valve",
        dedupeKey,
        undefined,
        null,
        dedupeKey,
        key,
      );

      this.logger.log(
        `process-uploaded-demo done steam_id=${steam_id} match_id=${result.matchId ?? "<none>"}${result.skipped ? ` skipped=${result.skipped}` : ""}`,
      );

      await this.s3.remove(key);
    } catch (error) {
      if (lastAttempt) {
        await this.s3.remove(key);
        this.logger.warn(
          `process-uploaded-demo failed steam_id=${steam_id} key=${key}: ${(error as Error)?.message ?? error}`,
        );
      }
      throw error;
    }
  }
}
