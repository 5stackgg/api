import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { PostgresService } from "../postgres/postgres.service";
import { S3Config } from "../configs/types/S3Config";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

// A file under clips/ is served only on a link carrying `exp` and `sig`, which
// the computed fields mint (file_url_signature.sql) for rows the viewer may
// read. The key is derived from the bucket secret because the Cloudflare
// worker holds that too (5stack-panel cloudflare-workers/backblaze-proxy), so
// both check the same links with nothing new to provision.
@Injectable()
export class FileUrlSigningService implements OnApplicationBootstrap {
  public static readonly KEY_LABEL = "5stack-file-url-v1";
  private static readonly STORE_RETRY_MS = 5_000;

  private readonly key: Buffer | null;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly postgres: PostgresService,
  ) {
    const secret = this.config.get<S3Config>("s3")?.secret;
    this.key = secret
      ? createHmac("sha256", secret)
          .update(FileUrlSigningService.KEY_LABEL)
          .digest()
      : null;
  }

  // Awaited, so a pod booting after the migrations signs from its first
  // request. The table comes from a migration that hasura's init container
  // runs, which can still be running when this pod boots; until then the
  // computed fields hand links out unsigned (file_url_signature.sql).
  public async onApplicationBootstrap() {
    try {
      await this.storeKey();
    } catch (error) {
      this.logger.warn(
        `unable to store the file link signing key, retrying: ${(error as Error)?.message}`,
      );
      void this.storeKeyUntilStored();
    }
  }

  public async storeKey() {
    if (!this.key) {
      this.logger.warn(
        "S3_SECRET is not set, so no clip or lineup file link can be signed",
      );
      return;
    }
    await this.postgres.query(
      `INSERT INTO private.file_url_signing_key (id, key) VALUES (true, $1)
       ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key
        WHERE file_url_signing_key.key IS DISTINCT FROM EXCLUDED.key`,
      [this.key],
    );
  }

  public verify(fileKey: string, exp: unknown, sig: unknown): boolean {
    if (
      !this.key ||
      typeof exp !== "string" ||
      !/^\d{1,12}$/.test(exp) ||
      Number(exp) * 1000 < Date.now()
    ) {
      return false;
    }
    return timingSafeStringEqual(
      sig,
      createHmac("sha256", this.key)
        .update(`${fileKey}\n${exp}`)
        .digest("base64url"),
    );
  }

  private async storeKeyUntilStored() {
    let stored = false;
    while (!stored) {
      await new Promise((resolve) =>
        setTimeout(resolve, FileUrlSigningService.STORE_RETRY_MS).unref(),
      );
      stored = await this.storeKey().then(
        () => true,
        () => false,
      );
    }
  }
}
