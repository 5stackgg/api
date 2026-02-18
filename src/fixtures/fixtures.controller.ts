import { Controller, Logger } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { PostgresService } from "../postgres/postgres.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { TypesenseQueues } from "../type-sense/enums/TypesenseQueues";
import { RefreshAllPlayersJob } from "../type-sense/jobs/RefreshAllPlayers";
import { TypeSenseService } from "../type-sense/type-sense.service";
import fs from "fs";
import path from "path";

const FIXTURE_STEAM_ID_START = 76561198000000001n;
const FIXTURE_STEAM_ID_END = 76561198000000040n;

@Controller("fixtures")
export class FixturesController {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly typeSense: TypeSenseService,
    @InjectQueue(TypesenseQueues.TypeSense) private typesenseQueue: Queue,
  ) {}

  @HasuraAction()
  public async loadFixtures() {
    if (!process.env.DEV) {
      return { success: false };
    }

    try {
      const cleanupSql = fs.readFileSync(
        path.resolve("./hasura/fixtures/cleanup.sql"),
        "utf8",
      );
      const fixturesSql = fs.readFileSync(
        path.resolve("./hasura/fixtures/fixtures.sql"),
        "utf8",
      );

      this.logger.log("Fixtures: Running cleanup...");
      await this.postgres.query(cleanupSql);

      this.logger.log("Fixtures: Loading fixture data...");
      await this.postgres.query(fixturesSql);

      this.logger.log("Fixtures: Refreshing Typesense player index...");
      await this.typesenseQueue.add(RefreshAllPlayersJob.name, {});

      // Delayed refresh to catch ELO calculations that complete after the first refresh
      await this.typesenseQueue.add(
        RefreshAllPlayersJob.name,
        {},
        { delay: 30000, jobId: "fixtures-delayed-refresh" },
      );

      this.logger.log("Fixtures: Complete");
      return { success: true };
    } catch (error) {
      this.logger.error("Fixtures: Failed to load", error);
      throw error;
    }
  }

  @HasuraAction()
  public async removeFixtures() {
    if (!process.env.DEV) {
      return { success: false };
    }

    try {
      const cleanupSql = fs.readFileSync(
        path.resolve("./hasura/fixtures/cleanup.sql"),
        "utf8",
      );

      this.logger.log("Fixtures: Removing fixture data...");
      await this.postgres.query(cleanupSql);

      this.logger.log("Fixtures: Removing fixture players from Typesense...");
      for (
        let steamId = FIXTURE_STEAM_ID_START;
        steamId <= FIXTURE_STEAM_ID_END;
        steamId++
      ) {
        try {
          await this.typeSense.removePlayer(steamId.toString());
        } catch {
          // Player may not exist in Typesense, ignore
        }
      }

      this.logger.log("Fixtures: Removed");
      return { success: true };
    } catch (error) {
      this.logger.error("Fixtures: Failed to remove", error);
      throw error;
    }
  }
}
