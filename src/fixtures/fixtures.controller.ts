import { Controller, Logger } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { PostgresService } from "../postgres/postgres.service";
import fs from "fs";
import path from "path";

@Controller("fixtures")
export class FixturesController {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
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

      this.logger.log("Fixtures: Removed");
      return { success: true };
    } catch (error) {
      this.logger.error("Fixtures: Failed to remove", error);
      throw error;
    }
  }
}
