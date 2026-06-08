import { Injectable } from "@nestjs/common";
import { PoolClient } from "pg";
import { PostgresService } from "../../postgres/postgres.service";

export class NoSteamAccountAvailableError extends Error {
  constructor(
    message = "no Steam account available — add more accounts to the pool",
  ) {
    super(message);
    this.name = "NoSteamAccountAvailableError";
  }
}

export type ClaimedSteamAccount = {
  id: string;
  username: string;
  password: string;
};

export type SteamClaimPurpose = "live" | "demo" | "highlights" | "bake";

type Queryable = Pick<PoolClient, "query">;

@Injectable()
export class SteamAccountService {
  // Grace window before a claim with no running pod is treated as stale.
  private static readonly REAP_GRACE_SECONDS = 120;

  constructor(private readonly postgres: PostgresService) {}

  // Pass `client` to enlist in the caller's transaction (e.g. alongside a
  // GPU-node claim) so both roll back together.
  async claim(
    opts: { nodeId?: string | null; jobName: string; purpose: SteamClaimPurpose },
    client?: PoolClient,
  ): Promise<ClaimedSteamAccount> {
    const run = async (c: Queryable): Promise<ClaimedSteamAccount> => {
      // Clear a prior claim for this job so a re-launch can reuse its account.
      await c.query(`DELETE FROM steam_account_claims WHERE k8s_job_name = $1`, [
        opts.jobName,
      ]);
      const result = await c.query(
        `WITH chosen AS (SELECT claim_free_steam_account($1) AS id),
              ins AS (
                INSERT INTO steam_account_claims
                  (steam_account_id, node_id, k8s_job_name, purpose)
                SELECT chosen.id, $1, $2, $3 FROM chosen
                 WHERE chosen.id IS NOT NULL
                RETURNING steam_account_id
              )
         SELECT sa.id, sa.username, sa.password
           FROM ins
           JOIN steam_accounts sa ON sa.id = ins.steam_account_id`,
        [opts.nodeId ?? null, opts.jobName, opts.purpose],
      );
      const row = result.rows[0];
      if (!row?.id) {
        throw new NoSteamAccountAvailableError();
      }
      return {
        id: String(row.id),
        username: String(row.username),
        password: String(row.password),
      };
    };

    return client ? run(client) : this.postgres.transaction(run);
  }

  async release(jobName: string): Promise<void> {
    await this.postgres.query(
      `DELETE FROM steam_account_claims WHERE k8s_job_name = $1`,
      [jobName],
    );
  }

  // Drop claims whose job is no longer running (crash-safety net).
  async reconcile(liveJobNames: string[]): Promise<number> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `DELETE FROM steam_account_claims
        WHERE created_at < now() - make_interval(secs => $1)
          AND k8s_job_name <> ALL($2::text[])
        RETURNING id`,
      [SteamAccountService.REAP_GRACE_SECONDS, liveJobNames],
    );
    return rows.length;
  }
}
