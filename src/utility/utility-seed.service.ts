import { readFile } from "fs/promises";
import { join } from "path";
import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { UtilityImportService } from "./utility-import.service";

@Injectable()
export class UtilitySeedService {
  // Relative to the process cwd, which is the app root in both the container
  // and a local run -- the same place hasura/migrations is resolved from.
  public static readonly SEED_FILE = join(
    "hasura",
    "seeds",
    "utility-lineups.json",
  );

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly imports: UtilityImportService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seed();
    } catch (error) {
      // A library that failed to seed is an empty library, not a broken
      // install. Never take the API down over it.
      this.logger.warn(
        `[utility-seed] skipped: ${(error as Error)?.message ?? "unknown error"}`,
      );
    }
  }

  public async seed(): Promise<void> {
    const payload = await this.read();

    if (!payload) {
      return;
    }

    // Rows are authored by somebody, and a bundled library has no author of
    // its own. An install with no administrator yet is a fresh one, so leave
    // it: the next boot after somebody signs in will seed.
    const owner = await this.owner();

    if (!owner) {
      this.logger.log(
        "[utility-seed] no administrator yet, deferring the default library",
      );
      return;
    }

    const result = await this.imports.seedLineups(owner, payload);

    if (result.imported === 0 && result.updated === 0) {
      return;
    }

    this.logger.log(
      `[utility-seed] ${result.imported} added, ${result.updated} refreshed, ` +
        `${result.failed} rejected of ${result.total}`,
    );
  }

  private async read(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(UtilitySeedService.SEED_FILE, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async owner(): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM public.players
        WHERE role = 'administrator'
        ORDER BY steam_id
        LIMIT 1`,
    );

    return row?.steam_id ?? null;
  }
}
