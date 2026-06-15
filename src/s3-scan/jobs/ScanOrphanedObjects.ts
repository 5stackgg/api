import { WorkerHost } from "@nestjs/bullmq";
import { S3ScanQueues } from "../enums/S3ScanQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { S3ScanService } from "../s3-scan.service";

@UseQueue("S3Scan", S3ScanQueues.Scan)
export class ScanOrphanedObjects extends WorkerHost {
  constructor(private readonly s3Scan: S3ScanService) {
    super();
  }

  async process(): Promise<number> {
    const result = await this.s3Scan.scan();
    return result.orphan_objects;
  }
}
