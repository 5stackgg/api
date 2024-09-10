import { User } from "../auth/types/User";
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

@Injectable()
export class HasuraService {
  private config: HasuraConfig;

  constructor(
    protected readonly logger: Logger,
    protected readonly cache: CacheService,
    protected readonly configService: ConfigService,
    protected readonly postgresService: PostgresService,
  ) {
    this.config = configService.get<HasuraConfig>("hasura");
  }

  public static PLAYER_ROLE_CACHE_KEY(steamId: bigint | string) {
    return `user:${steamId.toString()}`;
  }

  public async query<R extends query_rootGenqlSelection>(
    request: R & { __name?: string },
    user?: User,
  ): Promise<FieldsSelection<query_root, R>> {
    try {
      return await (await this.getClient(user)).query(request);
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

  private async getClient(user?: User) {
    return createClient({
      url: `${this.config.endpoint}/v1/graphql`,
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": this.config.secret,
        ...(user ? await this.getHasuraHeaders(user) : {}),
      },
    });
  }

  public async getHasuraHeaders(user: User) {
    const playerRole = await this.cache.remember(
      HasuraService.PLAYER_ROLE_CACHE_KEY(user.steam_id),
      async () => {
        const { players_by_pk } = await this.query({
          players_by_pk: {
            __args: {
              steam_id: user.steam_id,
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
      "x-hasura-user-id": user.steam_id.toString(),
    };
  }

  public async setup() {
    await this.postgresService.query('create schema hdb_catalog');
    await this.postgresService.query(
      "create table if not exists hdb_catalog.schema_migratios (version bigint not null, dirty boolean not null)",
    );

    await this.applyMigrations(path.resolve("./hasura/migrations/default"));

    await this.apply(path.resolve("./hasura/enums"));
    await this.apply(path.resolve("./hasura/functions"));
    await this.apply(path.resolve("./hasura/triggers"));
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
      const files = fs.readdirSync(filePath);
      for (const file of files) {
        await this.apply(path.join(filePath, file));
      }
      return;
    }

    try {
      const sql = fs.readFileSync(filePath, "utf8");

      const digest = this.calcSqlDigest(sql);
      const setting = path.basename(filePath.replace(".sql", ""));

      if (digest === (await this.getSetting(setting))) {
        return;
      }

      this.logger.log(`    applying ${path.basename(filePath)}`);
      await this.postgresService.query(`begin;${sql};commit;`);

      await this.setSetting(setting, digest);
    } catch (error) {
      throw new Error(
        `failed to exec sql ${path.basename(filePath)}: ${error.message}`,
      );
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
