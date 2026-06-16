import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createClient,
  FieldsSelection,
  type mutation_root,
  type mutation_rootGenqlSelection,
  type query_root,
  type query_rootGenqlSelection,
} from "../../generated";
import { HasuraConfig } from "../configs/types/HasuraConfig";
import { CacheService } from "../cache/cache.service";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { AppConfig } from "../configs/types/AppConfig";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

@Injectable()
export class HasuraService {
  private config: HasuraConfig;
  private appConfig: AppConfig;

  // Setting name (relative path) of the player stats recompute function file.
  private static RECOMPUTE_STATS_SETTING =
    "hasura/functions/stats/recompute_player_match_map_stats";

  // Marker in migration_hashes.hashes signalling a full recompute is owed
  // because the recompute function's logic changed. Picked up and run in the
  // background by recomputePlayerStatsIfPending() so setup never blocks on it.
  private static RECOMPUTE_PENDING_KEY =
    "recompute_player_match_map_stats:pending";

  // Settings (relative paths) actually re-applied during the last setup().
  private appliedSettings = new Set<string>();

  constructor(
    protected readonly logger: Logger,
    protected readonly cache: CacheService,
    protected readonly configService: ConfigService,
    protected readonly postgresService: PostgresService,
  ) {
    this.appConfig = configService.get<AppConfig>("app");
    this.config = configService.get<HasuraConfig>("hasura");
  }

  public static PLAYER_NAME_CACHE_KEY(steamId: bigint | string) {
    return `user:name:${steamId.toString()}`;
  }

  public static PLAYER_ROLE_CACHE_KEY(steamId: bigint | string) {
    return `user:role:${steamId.toString()}`;
  }

  public static PLAYER_LAST_SIGN_IN_CACHE_KEY(steamId: bigint | string) {
    return `user:last_sign_in_at:v2:${steamId.toString()}`;
  }

  public checkSecret(secret: string) {
    return timingSafeStringEqual(secret, this.config.secret);
  }

  public async query<R extends query_rootGenqlSelection>(
    request: R & { __name?: string },
    steamId?: string,
  ): Promise<FieldsSelection<query_root, R>> {
    try {
      return await (await this.getClient(steamId)).query(request);
    } catch (error) {
      if (error?.response) {
        throw error?.response.errors.at(0).message;
      }
      throw error;
    }
  }

  public async mutation<R extends mutation_rootGenqlSelection>(
    request: R & { __name?: string },
  ): Promise<FieldsSelection<mutation_root, R>> {
    try {
      return await (await this.getClient()).mutation(request);
    } catch (error) {
      if (error?.response) {
        throw error?.response.errors.at(0).message;
      }
      throw error;
    }
  }

  private async getClient(steamId?: string) {
    return createClient({
      url: `${this.config.endpoint}/v1/graphql`,
      // @ts-ignore
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": this.config.secret,
        ...(steamId ? await this.getHasuraHeaders(steamId) : {}),
      },
    });
  }

  public async getHasuraHeaders(steamId: string) {
    const playerRole = await this.cache.remember(
      HasuraService.PLAYER_ROLE_CACHE_KEY(steamId),
      async () => {
        const { players_by_pk } = await this.query({
          players_by_pk: {
            __args: {
              steam_id: steamId,
            },
            role: true,
          },
        });

        return players_by_pk?.role;
      },
      60 * 60 * 1000,
    );

    return {
      "x-hasura-role": playerRole,
      "x-hasura-user-id": steamId,
    };
  }

  public async setup() {
    this.appliedSettings.clear();

    await this.postgresService.query("create schema if not exists hdb_catalog");
    await this.postgresService.query(
      "create table if not exists hdb_catalog.schema_migrations (version bigint not null, dirty boolean not null)",
    );

    await this.applyMigrations(path.resolve("./hasura/migrations/default"));

    await this.apply(path.resolve("./hasura/enums"));
    await this.apply(path.resolve("./hasura/functions"));
    await this.apply(path.resolve("./hasura/views"));
    await this.apply(path.resolve("./hasura/triggers"));

    await this.updateSettings();

    // The recompute over every map can run for minutes — far past the pool's
    // statement_timeout — so flag it here and let the long-lived process run it
    // in the background instead of blocking (and timing out) setup.
    if (this.appliedSettings.has(HasuraService.RECOMPUTE_STATS_SETTING)) {
      this.logger.log("Stats: recompute logic changed, flagging recompute");
      await this.setSetting(HasuraService.RECOMPUTE_PENDING_KEY, "1");
    }

    if (process.env.LOAD_FIXTURES === "true") {
      const fixturesPath = path.resolve("./hasura/fixtures");
      if (fs.existsSync(fixturesPath)) {
        this.logger.log("Fixtures: Loading dev fixture data...");
        await this.apply(fixturesPath);
        this.logger.log("Fixtures: Complete");
      }
    }
  }

  private async updateSettings() {
    await this.postgresService.query(
      "insert into settings (name, value) values ('demos_domain', $1) on conflict (name) do update set value = $1",
      [this.appConfig.demosDomain],
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('relay_domain', $1) on conflict (name) do update set value = $1",
      [this.appConfig.relayDomain],
    );
  }

  private async applyMigrations(path: string): Promise<number> {
    let completed = 0;
    const applied = await this.getAppliedVersions();
    const available = await this.getAvailableVersions(path);

    if (available.size > 0) {
      this.logger.log("Migrations: Running");
      for (const [version, sql] of available) {
        if (!applied.has(version)) {
          this.logger.log("    applying", version.toString());
          let patchedSQL = sql;
          const disableTransactions = sql.startsWith(`-- @disable-transaction`);
          const updateSchemaMigrations = `insert into hdb_catalog.schema_migrations (version, dirty) values (${version}, false)`;
          if (!disableTransactions) {
            patchedSQL = `begin;${patchedSQL};${updateSchemaMigrations};commit;`;
          }

          try {
            await this.postgresService.query(patchedSQL);
            if (disableTransactions) {
              await this.postgresService.query(updateSchemaMigrations);
            }
            completed++;
          } catch (error) {
            throw new Error(
              `failed to apply migration ${version}: ${error.message}`,
            );
          }
        }
      }

      if (completed > 0) {
        await this.postgresService.query(`select pg_stat_reset();`);
        await this.postgresService.query(`select pg_stat_statements_reset();`);
      }

      this.logger.log(`Migrations: ${completed} Completed`);
    }

    return completed;
  }

  private async getAvailableVersions(path: string) {
    const map = new Map<string, string>();
    const dirs = fs.readdirSync(path);
    for (const dir of dirs) {
      const version = dir.split("_").shift();
      if (version) {
        const file = `${path}/${dir}/up.sql`;
        const sql = fs.readFileSync(file, "utf8");
        if (map.get(version)) {
          throw Error(`duplicate version: ${version}`);
        }
        map.set(version, sql);
      }
    }
    return new Map(
      [...map.entries()].sort(([versionA], [versionB]) => {
        if (versionA > versionB) {
          return 1;
        } else if (versionA < versionB) {
          return -1;
        }
        return 0;
      }),
    );
  }

  private async getAppliedVersions() {
    const versions = new Set<string>();
    const appliedVerions = await this.postgresService.query<
      Array<{
        version: string;
      }>
    >("select version from hdb_catalog.schema_migrations order by version");
    for (const appliedVerion of appliedVerions) {
      versions.add(appliedVerion.version);
    }
    return versions;
  }

  public async apply(filePath: string): Promise<boolean> {
    const filePathStats = fs.statSync(filePath);

    if (filePathStats.isDirectory()) {
      const files = fs.readdirSync(filePath).sort();
      for (const file of files) {
        await this.apply(path.join(filePath, file));
      }
      return;
    }

    try {
      const sql = fs.readFileSync(filePath, "utf8");

      const digest = this.calcSqlDigest(sql);
      const setting = path.relative(
        process.cwd(),
        filePath.replace(".sql", ""),
      );

      if (digest === (await this.getSetting(setting))) {
        return;
      }

      this.logger.log(`    applying ${path.basename(filePath)}`);
      await this.postgresService.query(`begin;${sql};commit;`);

      await this.setSetting(setting, digest);
      this.appliedSettings.add(setting);
    } catch (error) {
      throw new Error(
        `failed to exec sql ${path.basename(filePath)}: ${error.message}`,
      );
    }
  }

  // Runs a pending full player-stats recompute in the background. Fire-and-forget:
  // it disables the statement timeout for its own connection only, never blocks
  // the caller, and clears the pending flag once it finishes.
  public async recomputePlayerStatsIfPending() {
    let pending: string | undefined;
    try {
      pending = await this.getSetting(HasuraService.RECOMPUTE_PENDING_KEY);
    } catch (error) {
      this.logger.warn(`Stats: unable to check recompute flag: ${error.message}`);
      return;
    }

    if (!pending) {
      return;
    }

    void this.recomputeAllPlayerStats();
  }

  private async recomputeAllPlayerStats() {
    this.logger.log("Stats: recomputing player match map stats in background");
    try {
      await this.postgresService.transaction(async (client) => {
        await client.query("SET LOCAL statement_timeout = 0");
        await client.query("SELECT public.recompute_all_player_match_map_stats()");
      });

      await this.postgresService.query(
        "DELETE FROM migration_hashes.hashes WHERE name = $1",
        [HasuraService.RECOMPUTE_PENDING_KEY],
      );

      this.logger.log("Stats: background recompute complete");
    } catch (error) {
      this.logger.error(`Stats: background recompute failed: ${error.message}`);
    }
  }

  public async getSetting(name: string) {
    try {
      const [data] = await this.postgresService.query<
        Array<{
          hash: string;
        }>
      >("SELECT hash FROM migration_hashes.hashes WHERE name = $1", [name]);

      return data?.hash;
    } catch (error) {
      throw new Error(`unable to get setting ${name}: ${error.message}`);
    }
  }

  public async setSetting(name: string, hash: string) {
    try {
      await this.postgresService.query(
        "insert into migration_hashes.hashes (name, hash) values ($1, $2) on conflict (name) do update set hash = $2",
        [name, hash],
      );
    } catch (error) {
      throw new Error(`unable to set setting ${name}: ${error.message}`);
    }
  }

  public calcSqlDigest(data: string | Array<string>) {
    const hash = crypto.createHash("sha256");
    if (!Array.isArray(data)) {
      data = [data];
    }

    for (const datum of data) {
      hash.update(datum);
    }

    return hash.digest("base64");
  }
}
