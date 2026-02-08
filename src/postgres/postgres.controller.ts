import { Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { PostgresService } from "./postgres.service";
import {
  DbStats,
  QueryStat,
  QueryDetail,
  ActiveQuery,
  TableStat,
  IndexStat,
  ConnectionStats,
  ActiveConnection,
  DatabaseStats,
  LockInfo,
  TableIOStat,
  IndexIOStat,
  TimescaleStats,
  HypertableInfo,
  TimescaleJob,
} from "../../generated";

@Controller("postgres")
export class PostgresController {
  constructor(private readonly postgres: PostgresService) {}

  @HasuraAction()
  public async dbStats(): Promise<DbStats[]> {
    // Define a type for the result rows
    type DbStatRow = {
      queryid: string | number;
      query: string;
      calls: number;
      total_exec_time: number;
      mean_exec_time: number;
      max_exec_time: number;
      min_exec_time: number;
      total_rows: number;
      shared_blks_hit: number;
      shared_blks_read: number;
      local_blks_hit: number;
      local_blks_read: number;
    };

    const result = await this.postgres.query<DbStatRow>(`
      SELECT
          queryid,
          query,
          plan,
          SUM(calls) AS calls,
          SUM(total_exec_time) AS total_exec_time,
          AVG(mean_exec_time) AS mean_exec_time,
          MAX(max_exec_time) AS max_exec_time,
          MIN(min_exec_time) AS min_exec_time,
          SUM(rows) AS total_rows,
          SUM(shared_blks_hit) AS shared_blks_hit,
          SUM(shared_blks_read) AS shared_blks_read,
          SUM(local_blks_hit) AS local_blks_hit,
          SUM(local_blks_read) AS local_blks_read
      FROM pg_stat_statements
      WHERE query NOT LIKE '/* pgbouncer */%'
      GROUP BY queryid, query
      HAVING SUM(calls) > 5
      ORDER BY mean_exec_time DESC
      LIMIT 50;
    `);

    return (result as unknown as any[]).map(
      (row): DbStats => ({
        __typename: "DbStats",
        queryid: String(row.queryid),
        query: String(row.query),
        calls: Number(row.calls),
        total_exec_time: Number(row.total_exec_time),
        mean_exec_time: Number(row.mean_exec_time),
        max_exec_time: Number(row.max_exec_time),
        min_exec_time: Number(row.min_exec_time),
        total_rows: Number(row.total_rows),
        shared_blks_hit: Number(row.shared_blks_hit),
        shared_blks_read: Number(row.shared_blks_read),
        local_blks_hit: Number(row.local_blks_hit),
        local_blks_read: Number(row.local_blks_read),
      }),
    );
  }

  @HasuraAction()
  public async getQueryStats(): Promise<QueryStat[]> {
    type QueryStatRow = {
      queryid: string;
      query: string;
      calls: number;
      total_exec_time: number;
      mean_exec_time: number;
      stddev_exec_time: number | null;
      min_exec_time: number;
      max_exec_time: number;
      total_rows: number;
      shared_blks_hit: number;
      shared_blks_read: number;
      cache_hit_ratio: number | null;
      temp_blks_written: number;
      local_blks_hit: number;
      local_blks_read: number;
    };

    const result = await this.postgres.query<QueryStatRow>(`
      SELECT
        queryid::text,
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        stddev_exec_time,
        min_exec_time,
        max_exec_time,
        rows as total_rows,
        shared_blks_hit,
        shared_blks_read,
        CASE
          WHEN (shared_blks_hit + shared_blks_read) > 0
          THEN shared_blks_hit::float / (shared_blks_hit + shared_blks_read)
          ELSE NULL
        END as cache_hit_ratio,
        temp_blks_written,
        local_blks_hit,
        local_blks_read
      FROM pg_stat_statements
      WHERE query NOT LIKE '/* pgbouncer */%'
        AND calls > 5
      ORDER BY mean_exec_time DESC
      LIMIT 100
    `);

    return (result as unknown as any[]).map((row) => ({
      __typename: "QueryStat",
      queryid: String(row.queryid),
      query: String(row.query),
      calls: Number(row.calls),
      total_exec_time: Number(row.total_exec_time),
      mean_exec_time: Number(row.mean_exec_time),
      stddev_exec_time:
        row.stddev_exec_time !== null ? Number(row.stddev_exec_time) : null,
      min_exec_time: Number(row.min_exec_time),
      max_exec_time: Number(row.max_exec_time),
      total_rows: Number(row.total_rows),
      shared_blks_hit: Number(row.shared_blks_hit),
      shared_blks_read: Number(row.shared_blks_read),
      cache_hit_ratio:
        row.cache_hit_ratio !== null ? Number(row.cache_hit_ratio) : null,
      temp_blks_written: Number(row.temp_blks_written),
      local_blks_hit: Number(row.local_blks_hit),
      local_blks_read: Number(row.local_blks_read),
    }));
  }

  @HasuraAction()
  public async getQueryDetail(args: {
    queryid: string;
  }): Promise<QueryDetail | null> {
    // First get the query stats
    type QueryStatRow = {
      queryid: string;
      query: string;
      calls: number;
      total_exec_time: number;
      mean_exec_time: number;
      stddev_exec_time: number | null;
      min_exec_time: number;
      max_exec_time: number;
      total_rows: number;
      shared_blks_hit: number;
      shared_blks_read: number;
      cache_hit_ratio: number | null;
      temp_blks_written: number;
      local_blks_hit: number;
      local_blks_read: number;
    };

    const statsResult = await this.postgres.query<QueryStatRow>(
      `
      SELECT
        queryid::text,
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        stddev_exec_time,
        min_exec_time,
        max_exec_time,
        rows as total_rows,
        shared_blks_hit,
        shared_blks_read,
        CASE
          WHEN (shared_blks_hit + shared_blks_read) > 0
          THEN shared_blks_hit::float / (shared_blks_hit + shared_blks_read)
          ELSE NULL
        END as cache_hit_ratio,
        temp_blks_written,
        local_blks_hit,
        local_blks_read
      FROM pg_stat_statements
      WHERE queryid::text = $1
      LIMIT 1
    `,
      [args.queryid],
    );

    if ((statsResult as unknown as any[]).length === 0) {
      return null;
    }

    const statRow = (statsResult as unknown as any[])[0];

    // Try to get EXPLAIN plan (may fail for queries with parameters)
    let explainPlan: string | null = null;
    try {
      // First try with generic plan for parameterized queries
      const explainResult = await this.postgres.query<{
        "QUERY PLAN": string;
      }>(`
        EXPLAIN (FORMAT TEXT, GENERIC_PLAN true) ${statRow.query}
      `);
      explainPlan = (explainResult as unknown as any[])
        .map((row) => row["QUERY PLAN"])
        .join("\n");
    } catch (error) {
      // If generic plan fails, try without it (works for non-parameterized queries)
      try {
        const explainResult = await this.postgres.query<{
          "QUERY PLAN": string;
        }>(`
          EXPLAIN (FORMAT TEXT) ${statRow.query}
        `);
        explainPlan = (explainResult as unknown as any[])
          .map((row) => row["QUERY PLAN"])
          .join("\n");
      } catch (innerError) {
        // EXPLAIN failed - this is common for parameterized queries from pg_stat_statements
        // Return a helpful message instead of null
        explainPlan =
          "EXPLAIN plan cannot be generated for parameterized queries.\n\n" +
          "The query contains parameter placeholders ($1, $2, etc.) that cannot be explained without actual values.\n\n" +
          "To see the execution plan, run EXPLAIN with actual parameter values in psql or your database client.";
      }
    }

    return {
      __typename: "QueryDetail",
      queryid: String(statRow.queryid),
      query: String(statRow.query),
      explain_plan: explainPlan,
      stats: {
        __typename: "QueryStat",
        queryid: String(statRow.queryid),
        query: String(statRow.query),
        calls: Number(statRow.calls),
        total_exec_time: Number(statRow.total_exec_time),
        mean_exec_time: Number(statRow.mean_exec_time),
        stddev_exec_time:
          statRow.stddev_exec_time !== null
            ? Number(statRow.stddev_exec_time)
            : null,
        min_exec_time: Number(statRow.min_exec_time),
        max_exec_time: Number(statRow.max_exec_time),
        total_rows: Number(statRow.total_rows),
        shared_blks_hit: Number(statRow.shared_blks_hit),
        shared_blks_read: Number(statRow.shared_blks_read),
        cache_hit_ratio:
          statRow.cache_hit_ratio !== null
            ? Number(statRow.cache_hit_ratio)
            : null,
        temp_blks_written: Number(statRow.temp_blks_written),
        local_blks_hit: Number(statRow.local_blks_hit),
        local_blks_read: Number(statRow.local_blks_read),
      },
    };
  }

  @HasuraAction()
  public async getActiveQueries(): Promise<ActiveQuery[]> {
    type ActiveQueryRow = {
      pid: number;
      usename: string;
      application_name: string | null;
      client_addr: string | null;
      state: string;
      wait_event_type: string | null;
      wait_event: string | null;
      query: string;
      query_start: Date;
      duration_seconds: number;
    };

    const result = await this.postgres.query<ActiveQueryRow>(`
      SELECT
        pid,
        usename,
        application_name,
        client_addr::text,
        state,
        wait_event_type,
        wait_event,
        query,
        query_start,
        EXTRACT(EPOCH FROM (now() - query_start)) as duration_seconds
      FROM pg_stat_activity
      WHERE state != 'idle'
        AND query NOT LIKE '/* pgbouncer */%'
        AND pid != pg_backend_pid()
      ORDER BY query_start ASC
    `);

    return (result as unknown as any[]).map((row) => ({
      __typename: "ActiveQuery",
      pid: Number(row.pid),
      usename: String(row.usename),
      application_name: row.application_name
        ? String(row.application_name)
        : null,
      client_addr: row.client_addr ? String(row.client_addr) : null,
      state: String(row.state),
      wait_event_type: row.wait_event_type ? String(row.wait_event_type) : null,
      wait_event: row.wait_event ? String(row.wait_event) : null,
      query: String(row.query),
      query_start: row.query_start,
      duration_seconds: Number(row.duration_seconds),
    }));
  }

  @HasuraAction()
  public async getTableStats(): Promise<TableStat[]> {
    type TableStatRow = {
      schemaname: string;
      relname: string;
      seq_scan: number;
      seq_tup_read: number;
      idx_scan: number | null;
      idx_tup_fetch: number | null;
      n_tup_ins: number;
      n_tup_upd: number;
      n_tup_del: number;
      n_tup_hot_upd: number;
      n_live_tup: number;
      n_dead_tup: number;
      last_vacuum: Date | null;
      last_autovacuum: Date | null;
      last_analyze: Date | null;
      last_autoanalyze: Date | null;
    };

    const result = await this.postgres.query<TableStatRow>(`
      SELECT
        schemaname,
        relname,
        seq_scan,
        seq_tup_read,
        idx_scan,
        idx_tup_fetch,
        n_tup_ins,
        n_tup_upd,
        n_tup_del,
        n_tup_hot_upd,
        n_live_tup,
        n_dead_tup,
        last_vacuum,
        last_autovacuum,
        last_analyze,
        last_autoanalyze
      FROM pg_stat_user_tables
      ORDER BY seq_scan + COALESCE(idx_scan, 0) DESC
    `);

    return (result as unknown as any[]).map((row) => ({
      __typename: "TableStat",
      schemaname: String(row.schemaname),
      relname: String(row.relname),
      seq_scan: Number(row.seq_scan),
      seq_tup_read: Number(row.seq_tup_read),
      idx_scan: row.idx_scan !== null ? Number(row.idx_scan) : null,
      idx_tup_fetch:
        row.idx_tup_fetch !== null ? Number(row.idx_tup_fetch) : null,
      n_tup_ins: Number(row.n_tup_ins),
      n_tup_upd: Number(row.n_tup_upd),
      n_tup_del: Number(row.n_tup_del),
      n_tup_hot_upd: Number(row.n_tup_hot_upd),
      n_live_tup: Number(row.n_live_tup),
      n_dead_tup: Number(row.n_dead_tup),
      last_vacuum: row.last_vacuum,
      last_autovacuum: row.last_autovacuum,
      last_analyze: row.last_analyze,
      last_autoanalyze: row.last_autoanalyze,
    }));
  }

  @HasuraAction()
  public async getIndexStats(): Promise<IndexStat[]> {
    type IndexStatRow = {
      schemaname: string;
      tablename: string;
      indexname: string;
      idx_scan: number;
      idx_tup_read: number;
      idx_tup_fetch: number;
      index_size: number;
      table_size: number;
    };

    const result = await this.postgres.query<IndexStatRow>(`
      SELECT
        s.schemaname,
        s.relname as tablename,
        s.indexrelname as indexname,
        s.idx_scan,
        s.idx_tup_read,
        s.idx_tup_fetch,
        pg_relation_size(s.indexrelid) as index_size,
        pg_relation_size(s.relid) as table_size
      FROM pg_stat_user_indexes s
      ORDER BY s.idx_scan DESC
    `);

    return (result as unknown as any[]).map((row) => ({
      __typename: "IndexStat",
      schemaname: String(row.schemaname),
      tablename: String(row.tablename),
      indexname: String(row.indexname),
      idx_scan: Number(row.idx_scan),
      idx_tup_read: Number(row.idx_tup_read),
      idx_tup_fetch: Number(row.idx_tup_fetch),
      index_size: Number(row.index_size),
      table_size: Number(row.table_size),
    }));
  }

  @HasuraAction()
  public async getConnectionStats(): Promise<ConnectionStats> {
    type ConnectionByStateRow = {
      state: string;
      count: number;
      wait_event_type: string | null;
      waiting_count: number;
    };

    const result = await this.postgres.query<ConnectionByStateRow>(`
      SELECT
        state,
        COUNT(*) as count,
        wait_event_type,
        COUNT(*) FILTER (WHERE wait_event_type IS NOT NULL) as waiting_count
      FROM pg_stat_activity
      GROUP BY state, wait_event_type
    `);

    const byState = (result as unknown as any[]).map((row) => ({
      __typename: "ConnectionByState" as const,
      state: String(row.state),
      count: Number(row.count),
      wait_event_type: row.wait_event_type ? String(row.wait_event_type) : null,
      waiting_count: Number(row.waiting_count),
    }));

    // Calculate totals
    const total = byState.reduce((sum, row) => sum + row.count, 0);
    const active = byState
      .filter((row) => row.state === "active")
      .reduce((sum, row) => sum + row.count, 0);
    const idle = byState
      .filter((row) => row.state === "idle")
      .reduce((sum, row) => sum + row.count, 0);
    const idleInTransaction = byState
      .filter((row) => row.state === "idle in transaction")
      .reduce((sum, row) => sum + row.count, 0);
    const waiting = byState.reduce((sum, row) => sum + row.waiting_count, 0);

    return {
      __typename: "ConnectionStats",
      total,
      active,
      idle,
      idle_in_transaction: idleInTransaction,
      waiting,
      by_state: byState,
    };
  }

  @HasuraAction()
  public async getActiveConnections(): Promise<ActiveConnection[]> {
    type ActiveConnectionRow = {
      pid: number;
      usename: string | null;
      application_name: string | null;
      client_addr: string | null;
      state: string | null;
      query: string;
      query_start: Date | null;
    };

    const result = await this.postgres.query<ActiveConnectionRow>(`
      SELECT
        pid,
        usename,
        application_name,
        client_addr::text,
        state,
        query,
        query_start
      FROM pg_stat_activity
      WHERE pid != pg_backend_pid()
      ORDER BY query_start ASC NULLS LAST
    `);

    return (result as unknown as any[]).map((row) => ({
      __typename: "ActiveConnection",
      pid: Number(row.pid),
      usename: row.usename ? String(row.usename) : null,
      application_name: row.application_name
        ? String(row.application_name)
        : null,
      client_addr: row.client_addr ? String(row.client_addr) : null,
      state: row.state ? String(row.state) : null,
      query: String(row.query),
      query_start: row.query_start,
    }));
  }

  @HasuraAction()
  public async getDatabaseStats(): Promise<DatabaseStats> {
    type DatabaseStatsRow = {
      datname: string;
      numbackends: number;
      xact_commit: number;
      xact_rollback: number;
      blks_read: number;
      blks_hit: number;
      cache_hit_ratio: number;
      tup_returned: number;
      tup_fetched: number;
      tup_inserted: number;
      tup_updated: number;
      tup_deleted: number;
      conflicts: number;
      deadlocks: number;
    };

    const result = await this.postgres.query<DatabaseStatsRow>(`
      SELECT
        datname,
        numbackends,
        xact_commit,
        xact_rollback,
        blks_read,
        blks_hit,
        CASE
          WHEN (blks_hit + blks_read) > 0
          THEN blks_hit::float / (blks_hit + blks_read)
          ELSE 0
        END as cache_hit_ratio,
        tup_returned,
        tup_fetched,
        tup_inserted,
        tup_updated,
        tup_deleted,
        conflicts,
        deadlocks
      FROM pg_stat_database
      WHERE datname = current_database()
    `);

    const row = (result as unknown as any[])[0];

    return {
      __typename: "DatabaseStats",
      datname: String(row.datname),
      numbackends: Number(row.numbackends),
      xact_commit: Number(row.xact_commit),
      xact_rollback: Number(row.xact_rollback),
      blks_read: Number(row.blks_read),
      blks_hit: Number(row.blks_hit),
      cache_hit_ratio: Number(row.cache_hit_ratio),
      tup_returned: Number(row.tup_returned),
      tup_fetched: Number(row.tup_fetched),
      tup_inserted: Number(row.tup_inserted),
      tup_updated: Number(row.tup_updated),
      tup_deleted: Number(row.tup_deleted),
      conflicts: Number(row.conflicts),
      deadlocks: Number(row.deadlocks),
    };
  }

  @HasuraAction()
  public async getCurrentLocks(): Promise<LockInfo[]> {
    type LockInfoRow = {
      locktype: string;
      relation: string | null;
      mode: string;
      granted: boolean;
      usename: string | null;
      query: string | null;
      pid: number;
    };

    const result = await this.postgres.query<LockInfoRow>(`
      SELECT
        l.locktype,
        l.relation::regclass::text as relation,
        l.mode,
        l.granted,
        a.usename,
        a.query,
        a.pid
      FROM pg_locks l
      LEFT JOIN pg_stat_activity a ON l.pid = a.pid
      ORDER BY l.granted ASC, l.pid
    `);

    return (result as unknown as any[]).map((row) => ({
      __typename: "LockInfo",
      locktype: String(row.locktype),
      relation: row.relation ? String(row.relation) : null,
      mode: String(row.mode),
      granted: Boolean(row.granted),
      usename: row.usename ? String(row.usename) : null,
      query: row.query ? String(row.query) : null,
      pid: Number(row.pid),
    }));
  }

  @HasuraAction()
  public async getVacuumProgress(): Promise<any[]> {
    // Check if pg_stat_progress_vacuum exists (PostgreSQL 9.6+)
    const result = await this.postgres.query<any>(`
      SELECT
        pid,
        datname,
        relid::regclass::text as table_name,
        phase,
        heap_blks_total,
        heap_blks_scanned,
        heap_blks_vacuumed,
        index_vacuum_count,
        max_dead_tuples,
        num_dead_tuples
      FROM pg_stat_progress_vacuum
    `);

    return result as unknown as any[];
  }

  @HasuraAction()
  public async getTableIOStats(): Promise<TableIOStat[]> {
    type TableIOStatRow = {
      schemaname: string;
      relname: string;
      heap_blks_read: number;
      heap_blks_hit: number;
      idx_blks_read: number;
      idx_blks_hit: number;
      cache_hit_ratio: number | null;
    };

    const result = await this.postgres.query<TableIOStatRow>(`
      SELECT
        schemaname,
        relname,
        heap_blks_read,
        heap_blks_hit,
        idx_blks_read,
        idx_blks_hit,
        CASE
          WHEN (heap_blks_hit + heap_blks_read + idx_blks_hit + idx_blks_read) > 0
          THEN (heap_blks_hit + idx_blks_hit)::float / (heap_blks_hit + heap_blks_read + idx_blks_hit + idx_blks_read)
          ELSE NULL
        END as cache_hit_ratio
      FROM pg_statio_user_tables
      ORDER BY (heap_blks_read + idx_blks_read) DESC
    `);

    return (result as unknown as any[]).map((row) => ({
      __typename: "TableIOStat",
      schemaname: String(row.schemaname),
      relname: String(row.relname),
      heap_blks_read: Number(row.heap_blks_read),
      heap_blks_hit: Number(row.heap_blks_hit),
      idx_blks_read: Number(row.idx_blks_read),
      idx_blks_hit: Number(row.idx_blks_hit),
      cache_hit_ratio:
        row.cache_hit_ratio !== null ? Number(row.cache_hit_ratio) : null,
    }));
  }

  @HasuraAction()
  public async getIndexIOStats(): Promise<IndexIOStat[]> {
    type IndexIOStatRow = {
      schemaname: string;
      tablename: string;
      indexname: string;
      idx_blks_read: number;
      idx_blks_hit: number;
    };

    const result = await this.postgres.query<IndexIOStatRow>(`
      SELECT
        schemaname,
        relname as tablename,
        indexrelname as indexname,
        idx_blks_read,
        idx_blks_hit
      FROM pg_statio_user_indexes
      ORDER BY idx_blks_read DESC
    `);

    return (result as unknown as any[]).map((row) => ({
      __typename: "IndexIOStat",
      schemaname: String(row.schemaname),
      tablename: String(row.tablename),
      indexname: String(row.indexname),
      idx_blks_read: Number(row.idx_blks_read),
      idx_blks_hit: Number(row.idx_blks_hit),
    }));
  }

  @HasuraAction()
  public async getTimescaleStats(): Promise<TimescaleStats> {
    // Check if TimescaleDB is installed
    const extensionCheck = await this.postgres.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
      ) as exists
    `);

    const hasTimescale = (extensionCheck as unknown as any[])[0]?.exists;

    if (!hasTimescale) {
      throw new Error("TimescaleDB is not installed");
    }

    // Get hypertable information
    type HypertableRow = {
      hypertable_name: string;
      num_chunks: number;
      compression_enabled: boolean;
    };

    const hypertablesResult = await this.postgres.query<HypertableRow>(`
      SELECT
        hypertable_name,
        num_chunks,
        compression_enabled
      FROM timescaledb_information.hypertables
    `);

    const hypertables: HypertableInfo[] = (
      hypertablesResult as unknown as HypertableRow[]
    ).map((row) => ({
      __typename: "HypertableInfo" as const,
      hypertable_name: String(row.hypertable_name),
      num_chunks: Number(row.num_chunks),
      compression_enabled: Boolean(row.compression_enabled),
    }));

    // Get total chunks count
    const chunksResult = await this.postgres.query<{ count: number }>(`
      SELECT COUNT(*) as count
      FROM timescaledb_information.chunks
    `);

    const chunks_count = Number(
      (chunksResult as unknown as { count: number }[])[0]?.count || 0,
    );

    // Get jobs information
    type JobRow = {
      job_id: number;
      job_type: string;
      hypertable_name: string | null;
      last_run_status: string | null;
      next_start: Date | null;
    };

    const jobsResult = await this.postgres.query<JobRow>(`
      SELECT
        j.job_id,
        j.application_name as job_type,
        j.hypertable_name,
        js.last_run_status,
        j.next_start
      FROM timescaledb_information.jobs j
      LEFT JOIN timescaledb_information.job_stats js ON j.job_id = js.job_id
    `);

    const jobs: TimescaleJob[] = (jobsResult as unknown as any[]).map(
      (row) => ({
        __typename: "TimescaleJob" as const,
        job_id: Number(row.job_id),
        job_type: String(row.job_type),
        hypertable_name: row.hypertable_name
          ? String(row.hypertable_name)
          : null,
        last_run_status: row.last_run_status
          ? String(row.last_run_status)
          : null,
        next_start: row.next_start,
      }),
    );

    return {
      __typename: "TimescaleStats",
      hypertables,
      chunks_count,
      jobs,
    };
  }

  @HasuraAction()
  public async getSchemas(): Promise<string[]> {
    type SchemaRow = {
      schema_name: string;
    };

    const result = await this.postgres.query<SchemaRow>(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'timescaledb_information', 'timescaledb_experimental')
        AND schema_name NOT LIKE 'pg_temp_%'
        AND schema_name NOT LIKE 'pg_toast_temp_%'
      ORDER BY schema_name ASC
    `);

    return (result as unknown as SchemaRow[]).map((row) =>
      String(row.schema_name),
    );
  }

  @HasuraAction()
  public async getStorageStats(): Promise<any> {
    // Get summary statistics
    type SummaryRow = {
      total_database_size: number;
      total_table_size: number;
      total_indexes_size: number;
      estimated_reclaimable_space: number;
    };

    const summaryResult = await this.postgres.query<SummaryRow>(`
      SELECT
        SUM(pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname))) as total_database_size,
        SUM(pg_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname))) as total_table_size,
        SUM(pg_indexes_size(quote_ident(schemaname)||'.'||quote_ident(relname))) as total_indexes_size,
        SUM(CASE
          WHEN n_live_tup > 0
          THEN pg_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname))::float / n_live_tup * n_dead_tup
          ELSE 0
        END) as estimated_reclaimable_space
      FROM pg_stat_user_tables
    `);

    const summary = (summaryResult as unknown as SummaryRow[])[0];

    // Get per-table statistics
    type TableSizeRow = {
      schemaname: string;
      tablename: string;
      total_size: number;
      table_size: number;
      indexes_size: number;
      n_live_tup: number;
      n_dead_tup: number;
      estimated_dead_tuple_bytes: number;
    };

    const tablesResult = await this.postgres.query<TableSizeRow>(`
      SELECT
        schemaname,
        relname as tablename,
        pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname)) as total_size,
        pg_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname)) as table_size,
        pg_indexes_size(quote_ident(schemaname)||'.'||quote_ident(relname)) as indexes_size,
        n_live_tup,
        n_dead_tup,
        CASE
          WHEN n_live_tup > 0
          THEN pg_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname))::float / n_live_tup * n_dead_tup
          ELSE 0
        END as estimated_dead_tuple_bytes
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(relname)) DESC
    `);

    return {
      __typename: "StorageStats",
      summary: {
        __typename: "StorageSummary",
        total_database_size: Number(summary.total_database_size || 0),
        total_table_size: Number(summary.total_table_size || 0),
        total_indexes_size: Number(summary.total_indexes_size || 0),
        estimated_reclaimable_space: Number(
          summary.estimated_reclaimable_space || 0,
        ),
      },
      tables: (tablesResult as unknown as TableSizeRow[]).map((row) => ({
        __typename: "TableSizeInfo",
        schemaname: String(row.schemaname),
        tablename: String(row.tablename),
        total_size: Number(row.total_size),
        table_size: Number(row.table_size),
        indexes_size: Number(row.indexes_size),
        n_live_tup: Number(row.n_live_tup),
        n_dead_tup: Number(row.n_dead_tup),
        estimated_dead_tuple_bytes: Number(row.estimated_dead_tuple_bytes),
      })),
    };
  }
}
