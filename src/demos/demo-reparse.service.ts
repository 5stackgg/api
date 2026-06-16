import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { S3Service } from "../s3/s3.service";
import { DemoMetadataService } from "./demo-metadata.service";

const STATUS_KEY = "scans/reparse-all-demos.latest.json";
const PAGE_SIZE = 1000;
const PERSIST_EVERY = 25;

export type ReparseStatus = {
  running: boolean;
  canceled: boolean;
  started_at: string | null;
  finished_at: string | null;
  total: number;
  completed: number;
  failed: number;
  current_demo_id: string | null;
};

@Injectable()
export class DemoReparseService {
  private status: ReparseStatus = {
    running: false,
    canceled: false,
    started_at: null,
    finished_at: null,
    total: 0,
    completed: 0,
    failed: 0,
    current_demo_id: null,
  };
  private cancelRequested = false;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly s3: S3Service,
    private readonly demoMetadata: DemoMetadataService,
  ) {}

  public isRunning(): boolean {
    return this.status.running;
  }

  public requestCancel(): void {
    if (this.status.running) {
      this.cancelRequested = true;
    }
  }

  public async getStatus(): Promise<ReparseStatus> {
    if (this.status.running) {
      return { ...this.status };
    }
    const persisted = await this.loadStatus();
    if (!persisted) {
      return { ...this.status };
    }
    return { ...persisted, running: false };
  }

  public async runReparseAll(): Promise<void> {
    if (this.status.running) {
      throw new Error("reparse already in progress");
    }

    this.cancelRequested = false;
    this.status = {
      running: true,
      canceled: false,
      started_at: new Date().toISOString(),
      finished_at: null,
      total: 0,
      completed: 0,
      failed: 0,
      current_demo_id: null,
    };
    await this.persistStatus();

    try {
      const ids = await this.fetchAllDemoIds();
      this.status.total = ids.length;
      await this.persistStatus();

      this.logger.log(`[reparse-all] starting reparse of ${ids.length} demos`);

      for (const id of ids) {
        if (this.cancelRequested) {
          this.status.canceled = true;
          this.logger.warn("[reparse-all] canceled by request");
          break;
        }
        this.status.current_demo_id = id;
        try {
          await this.demoMetadata.reparseById(id);
        } catch (error) {
          this.status.failed += 1;
          this.logger.warn(
            `[reparse-all] demo ${id} failed: ${(error as Error)?.message}`,
          );
        }
        this.status.completed += 1;
        if (this.status.completed % PERSIST_EVERY === 0) {
          await this.persistStatus();
        }
      }
    } finally {
      this.status.running = false;
      this.status.current_demo_id = null;
      this.status.finished_at = new Date().toISOString();
      this.cancelRequested = false;
      await this.persistStatus();
      this.logger.log(
        `[reparse-all] finished: ${this.status.completed}/${this.status.total} processed, ${this.status.failed} failed${this.status.canceled ? " (canceled)" : ""}`,
      );
    }
  }

  private async fetchAllDemoIds(): Promise<string[]> {
    const ids: string[] = [];
    let lastId: string | null = null;
    for (;;) {
      const where = lastId ? { id: { _gt: lastId } } : {};
      const { match_map_demos } = await this.hasura.query({
        match_map_demos: {
          __args: {
            where,
            order_by: [{ id: "asc" }],
            limit: PAGE_SIZE,
          },
          id: true,
        },
      });
      if (!match_map_demos.length) {
        break;
      }
      for (const demo of match_map_demos) {
        ids.push(demo.id);
      }
      lastId = match_map_demos[match_map_demos.length - 1].id;
      if (match_map_demos.length < PAGE_SIZE) {
        break;
      }
    }
    return ids;
  }

  private async persistStatus(): Promise<void> {
    try {
      await this.s3.put(STATUS_KEY, Buffer.from(JSON.stringify(this.status)));
    } catch (error) {
      this.logger.warn(
        `[reparse-all] failed to persist status: ${(error as Error)?.message}`,
      );
    }
  }

  private async loadStatus(): Promise<ReparseStatus | null> {
    try {
      if (!(await this.s3.has(STATUS_KEY))) {
        return null;
      }
      const stream = await this.s3.get(STATUS_KEY);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString()) as ReparseStatus;
    } catch {
      return null;
    }
  }
}
