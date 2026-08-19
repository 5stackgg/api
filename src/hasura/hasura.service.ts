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
    await this.postgresService.query("create schema if not exists hdb_catalog");
    await this.postgresService.query(
      "create table if not exists hdb_catalog.schema_migrations (version bigint not null, dirty boolean not null)",
    );

    // The table shipped without a unique constraint, so a version could be
    // recorded twice -- which made `on conflict` guards against it silently do
    // nothing, and left the applied set looking like something it was not.
    // Dedupe first: the index cannot be created while duplicates exist.
    await this.postgresService.query(
      `DELETE FROM hdb_catalog.schema_migrations a
        USING hdb_catalog.schema_migrations b
        WHERE a.ctid > b.ctid AND a.version = b.version`,
    );

    await this.postgresService.query(
      "create unique index if not exists schema_migrations_version_idx on hdb_catalog.schema_migrations (version)",
    );

    await this.applyMigrations(path.resolve("./hasura/migrations/default"));

    await this.apply(path.resolve("./hasura/enums"));
    await this.apply(path.resolve("./hasura/functions"));
    await this.apply(path.resolve("./hasura/views"));
    await this.apply(path.resolve("./hasura/triggers"));

    await this.updateSettings();

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

    // Steam presence bot is on by default; seed the row so the admin toggle
    // reflects it. `do nothing` preserves an admin's explicit off.
    await this.postgresService.query(
      "insert into settings (name, value) values ('public.steam_presence_enabled', 'true') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.create_awards_role', 'administrator') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.grant_awards_role', 'administrator') on conflict (name) do nothing",
    );

    // Seeds the platform default new match_options rows inherit. `do nothing`
    // preserves an operator's explicit value (including 0, which disables the
    // veto timer entirely).
    await this.postgresService.query(
      "insert into settings (name, value) values ('public.veto_pick_timeout', '60') on conflict (name) do nothing",
    );

    // On by default, unlike cameras: party voice is a convenience for players
    // who opted into a lobby together, not a surveillance control. Seeded so
    // the admin toggle reflects it; `do nothing` preserves an explicit off.
    await this.postgresService.query(
      "insert into settings (name, value) values ('public.voice_chat_enabled', 'true') on conflict (name) do nothing",
    );

    // Platform defaults new match_options rows inherit. Both off: requiring a
    // webcam everywhere is a deliberate choice for an event, not a sane default,
    // and letting teammates watch each other is opt-in on top of that.
    await this.postgresService.query(
      "insert into settings (name, value) values ('public.camera_required_default', 'false') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.camera_allow_teammates_default', 'false') on conflict (name) do nothing",
    );

    // On wherever voice is, and gated the same way. Turning a camera on is still
    // always a deliberate act by the player -- these only decide whether the
    // control is offered at all. The two per-surface toggles are read by the web
    // app to decide which surfaces show it; the API only enforces the master.
    await this.postgresService.query(
      "insert into settings (name, value) values ('public.video_chat_enabled', 'true') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.video_chat_lobbies_enabled', 'true') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.video_chat_matches_enabled', 'true') on conflict (name) do nothing",
    );

    // The utility library is inert without a server, so it ships on. Practice
    // sessions consume a real game server slot, so that half ships off and is
    // an operator's deliberate choice.
    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_library_enabled', 'true') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_practice_enabled', 'true') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_practice_idle_minutes', '10') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_practice_reserved_servers', '2') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_practice_daily_limit', '10') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_lineup_daily_limit', '200') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_success_radius', '96') on conflict (name) do nothing",
    );

    // Three distinct players clearing five consecutive throws is a much harder
    // claim than one moderator's opinion, and it is the one the library can
    // actually collect at scale.
    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_verify_masteries', '3') on conflict (name) do nothing",
    );

    // A solve costs up to 300 grenades and two minutes of a practice pod, so it
    // is capped per caller like every other expensive path in the module.
    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_solves_per_hour', '6') on conflict (name) do nothing",
    );

    await this.postgresService.query(
      "insert into settings (name, value) values ('public.utility_import_enabled', 'false') on conflict (name) do nothing",
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
          const updateSchemaMigrations = `insert into hdb_catalog.schema_migrations (version, dirty) values (${version}, false) on conflict (version) do nothing`;
          if (!disableTransactions) {
            // Disable the pool's statement_timeout for the migration; some run long.
            patchedSQL = `begin;set local statement_timeout = 0;${patchedSQL};${updateSchemaMigrations};commit;`;
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
      // Migrations can legitimately run long (e.g. full stats recomputes); never
      // let the pool's statement_timeout abort them.
      await this.postgresService.query(
        `begin;set local statement_timeout = 0;${sql};commit;`,
      );

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
